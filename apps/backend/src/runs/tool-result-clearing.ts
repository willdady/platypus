import type { ModelMessage } from "ai";
import {
  CLEARABLE_TOOL_NAMES,
  CLEARED_TOOL_RESULT_MARKER,
  clearingEngaged,
  clearingPrefixLength,
  TOOL_CLEARING_BATCH,
  TOOL_RESULT_CLEARING_KEEP_RECENT,
  TOOL_RESULT_CLEARING_THRESHOLD,
  type ContextOccupancyReading,
} from "@platypus/schemas";

/**
 * Tool-result clearing (ADR-0018 Notes, issue #524; ADR-0041).
 *
 * Replaces the content of an older, allowlisted tool result in what one model
 * call receives, leaving the tool call and the tool-result part themselves in
 * place — only `output` changes. Send-time only: this never touches what is
 * persisted or what a User sees (`GLOSSARY.md` — Tool-result clearing).
 *
 * A pure function over `ModelMessage[]` plus occupancy and the declared
 * window, exactly the shape `runs/tool-result-clearing.test.ts` exercises
 * without a run around it. Wired into every Drive from the one seam that
 * assembles their shared model arguments — see `buildModelInvocation` in
 * `./run-plan.ts` — so no Drive shape can opt out.
 *
 * ## Batched boundary, sticky gate
 *
 * Clearing engages at `thresholdFraction` of the declared window (0.7) and,
 * once engaged, moves the survivor boundary by a whole batch of
 * `batchSize` (4) rather than by one result per pass. That is what makes the
 * cached prompt prefix survive: with a one-result-at-a-time rule the oldest
 * surviving message changes on almost every step, so the Provider's cache
 * misses from the moment clearing starts. A batch leaves the prefix
 * byte-identical until `batchSize` more clearable results have arrived.
 *
 * Engaging is sticky: the current reading reaching the trigger is enough, and
 * so is any earlier reading still on the Active path having reached it. Without
 * that a pass could clear a batch, the turn's last reading — taken with the
 * batch in place — could fall under the trigger, and the next turn would
 * re-send everything before clearing again the turn after. See
 * `clearingPrefixLength` and `clearingEngaged` in `@platypus/schemas`.
 */

export type ClearingPolicy = {
  /** Fraction of the declared Context window at which clearing engages. */
  thresholdFraction: number;
  /** How many of the most recent clearable tool results survive a pass. */
  keepRecent: number;
  /**
   * How many clearable results a pass moves the boundary by
   * (`clear_at_least`). See `TOOL_CLEARING_BATCH`.
   */
  batchSize: number;
};

export const DEFAULT_CLEARING_POLICY: ClearingPolicy = {
  thresholdFraction: TOOL_RESULT_CLEARING_THRESHOLD,
  keepRecent: TOOL_RESULT_CLEARING_KEEP_RECENT,
  batchSize: TOOL_CLEARING_BATCH,
};

/** Never treats a tool as read-only. The default for a caller with no MCP hints to consult. */
const NEVER_READ_ONLY = (): boolean => false;

/**
 * Whether a tool's results are clearable: it is on the core allowlist, or
 * `isReadOnlyTool` — the caller's answer for an MCP-declared `readOnlyHint`
 * (ADR-0021, issue #626) — says so. Deny by default: an unclassified core name
 * and an MCP tool with no (or no trustworthy) hint are both denied.
 *
 * This module stays a pure retention rule that knows nothing about MCP —
 * `isReadOnlyTool` is the seam the Tool session's read-only sidecar is
 * threaded through at, not a concept this module holds itself.
 */
export const isClearableToolName = (
  toolName: string,
  isReadOnlyTool: (toolName: string) => boolean = NEVER_READ_ONLY,
): boolean => CLEARABLE_TOOL_NAMES.has(toolName) || isReadOnlyTool(toolName);

/** The location of one tool-result part inside a `ModelMessage[]`. */
type ResultLocation = { messageIndex: number; partIndex: number };

/**
 * Every clearable tool-result part in `messages`, in transcript order — which
 * is recency order, since a Transcript only ever grows by appending.
 */
const clearableResultLocations = (
  messages: ModelMessage[],
  isReadOnlyTool: (toolName: string) => boolean,
): ResultLocation[] => {
  const locations: ResultLocation[] = [];
  messages.forEach((message, messageIndex) => {
    if (message.role !== "tool") return;
    message.content.forEach((part, partIndex) => {
      if (
        part.type === "tool-result" &&
        isClearableToolName(part.toolName, isReadOnlyTool)
      ) {
        locations.push({ messageIndex, partIndex });
      }
    });
  });
  return locations;
};

/** The part of a tool result clearing replaces. */
type ToolOutput = { type: string; value?: unknown };

const isCleared = (output: ToolOutput): boolean =>
  output.type === "text" && output.value === CLEARED_TOOL_RESULT_MARKER;

/**
 * Rebuilds `messages` with the first `count` clearable results cleared,
 * returning the same array reference when that changes nothing.
 */
const clearResults = (
  messages: ModelMessage[],
  locations: ResultLocation[],
  count: number,
): ModelMessage[] => {
  if (count === 0) return messages;

  const stale = new Set(
    locations
      .slice(0, count)
      .map((loc) => `${loc.messageIndex}:${loc.partIndex}`),
  );

  const cleared = messages.map((message, messageIndex) => {
    if (message.role !== "tool") return message;
    let changed = false;
    const content = message.content.map((part, partIndex) => {
      if (!stale.has(`${messageIndex}:${partIndex}`)) return part;
      // Already cleared on an earlier step: `prepareStep`'s override carries
      // forward, so "untouched" stays "same reference" once nothing is left.
      if (part.type === "tool-result" && isCleared(part.output)) return part;
      changed = true;
      return {
        ...part,
        output: { type: "text" as const, value: CLEARED_TOOL_RESULT_MARKER },
      };
    });
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- set in a callback, which TS narrowing does not track
    return changed ? { ...message, content } : message;
  });
  return cleared.every((message, i) => message === messages[i])
    ? messages
    : cleared;
};

/**
 * Clears the batched prefix of clearable tool results — the oldest
 * `floor((n - keepRecent) / batchSize) * batchSize` — with no occupancy check.
 * `applyToolResultClearing` below is the gated entry point every caller outside
 * this module should use; this is exported separately because the summary pass
 * must clear everything it is given (`keepRecent: 0`, which clears all), and
 * because the "which results survive" rule can then be tested on its own from
 * the gate.
 *
 * `isReadOnlyTool` is the caller's per-turn answer for a name outside the core
 * allowlist — an MCP's declared `readOnlyHint`, resolved by the Tool session
 * (issue #626). Absent, every tool outside the core allowlist is denied,
 * matching the deny-by-default posture this shipped with.
 *
 * Returns the same array reference when nothing changes, so a caller can tell
 * "untouched" from "rebuilt" without a deep comparison.
 */
export const clearStaleToolResults = (
  messages: ModelMessage[],
  policy: Pick<
    ClearingPolicy,
    "keepRecent" | "batchSize"
  > = DEFAULT_CLEARING_POLICY,
  isReadOnlyTool: (toolName: string) => boolean = NEVER_READ_ONLY,
): ModelMessage[] => {
  const locations = clearableResultLocations(messages, isReadOnlyTool);
  return clearResults(
    messages,
    locations,
    clearingPrefixLength({
      itemCount: locations.length,
      keepRecent: policy.keepRecent,
      batchSize: policy.batchSize,
    }),
  );
};

/** What decides whether a clearing pass runs at all. */
export type OccupancyReading = {
  /** The input-token count the model call this policy is about to feed. */
  occupancy?: number;
  /** The Org Admin's declared Context window for this model (ADR-0018). */
  contextWindow?: number;
  /**
   * Context occupancy readings already persisted on this Chat's Active path,
   * in transcript order — the sticky half of the gate. A reading that reached
   * the trigger keeps clearing engaged after a pass has moved the boundary
   * back under it. Absent for a delegated or headless run, which starts no
   * such history, and for a Chat's first turn.
   */
  priorReadings?: readonly (ContextOccupancyReading | null)[];
};

/**
 * The gated entry point: clears a batch of stale allowlisted tool results once
 * clearing has engaged — the current reading is at `thresholdFraction` of the
 * declared window, or an earlier reading on the Active path was.
 *
 * `clearingEngaged` requires a declared window, so an undeclared one clears
 * nothing — no fallback, no estimate, matching ADR-0018. Returns the same array
 * reference whenever it changes nothing, so a caller can assert "untouched" as
 * "same reference" rather than a deep comparison.
 */
export const applyToolResultClearing = (
  messages: ModelMessage[],
  reading: OccupancyReading,
  policy: ClearingPolicy = DEFAULT_CLEARING_POLICY,
  isReadOnlyTool: (toolName: string) => boolean = NEVER_READ_ONLY,
): ModelMessage[] => {
  if (
    !clearingEngaged({
      occupancy: reading.occupancy,
      contextWindow: reading.contextWindow,
      thresholdFraction: policy.thresholdFraction,
      priorReadings: reading.priorReadings,
    })
  ) {
    return messages;
  }
  return clearStaleToolResults(messages, policy, isReadOnlyTool);
};
