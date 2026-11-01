import type { ModelMessage } from "ai";
import {
  CLEARABLE_TOOL_NAMES,
  CLEARED_TOOL_RESULT_MARKER,
  clearingPrefixLength,
  observedValueSize,
  reclaimedCharacters,
  TOOL_RESULT_CLEARING_KEEP_RECENT,
  TOOL_RESULT_CLEARING_MIN_BATCH,
  TOOL_RESULT_CLEARING_TARGET,
  TOOL_RESULT_CLEARING_THRESHOLD,
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
 * ## Trigger/target hysteresis
 *
 * Clearing engages at `thresholdFraction` of the declared window (0.7) and,
 * once engaged, clears down to `targetFraction` (0.5) rather than clearing
 * every result past the keep-recent count. That gap is what makes the cached
 * prompt prefix survive: with a one-result-at-a-time rule the oldest surviving
 * message changes on almost every step, so the Provider's cache misses from
 * the moment clearing starts. Clearing a batch instead leaves the prefix
 * byte-identical until the window fills back up to the trigger.
 *
 * The target is a fraction of the window, not a number of results, because
 * the same rule has to mean the same thing on a 16K window and a 1M one; see
 * `TOOL_RESULT_CLEARING_TARGET` and `clearingPrefixLength` in
 * `@platypus/schemas`. The size of the batch is worked out from the observed
 * sizes of the results being cleared, never from a local token count: the
 * vendor-reported occupancy decides *whether* to clear, and the observed
 * characters decide *how much*, because tokenising locally is the estimate
 * ADR-0018 refuses.
 */

export type ClearingPolicy = {
  /** Fraction of the declared Context window at which clearing engages. */
  thresholdFraction: number;
  /**
   * Fraction of the declared window a pass clears down to. Below the trigger:
   * the gap is the headroom later steps grow into before clearing engages
   * again.
   */
  targetFraction: number;
  /** How many of the most recent clearable tool results survive a pass. */
  keepRecent: number;
  /**
   * The smallest batch a pass clears, so a pass is worth the cache
   * invalidation it causes (`clear_at_least`). See
   * `TOOL_RESULT_CLEARING_MIN_BATCH`.
   */
  minBatch: number;
};

export const DEFAULT_CLEARING_POLICY: ClearingPolicy = {
  thresholdFraction: TOOL_RESULT_CLEARING_THRESHOLD,
  targetFraction: TOOL_RESULT_CLEARING_TARGET,
  keepRecent: TOOL_RESULT_CLEARING_KEEP_RECENT,
  minBatch: TOOL_RESULT_CLEARING_MIN_BATCH,
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

type ToolOutput = { type: string; value?: unknown };

/**
 * Observed size of a tool result's payload — the part clearing replaces. The
 * SDK wraps a payload in `{ type, value }`; the frontend mirror sees the
 * payload unwrapped, so measuring `value` (not the wrapper) lets both count
 * the same characters.
 */
const resultPayloadSize = (output: ToolOutput): number =>
  observedValueSize(output.value);

const isCleared = (output: ToolOutput): boolean =>
  output.type === "text" && output.value === CLEARED_TOOL_RESULT_MARKER;

/**
 * Observed size, in characters, of what `messages` sends: text, tool calls and
 * tool results. Reasoning and file parts are left out on both sides — they are
 * not what clearing can free, and the frontend mirror can measure the same
 * subset from `PlatypusUIMessage` parts.
 *
 * Shared with Tool-input clearing, which clears calls rather than results but
 * has to measure the same conversation to land on the same batch size.
 */
export const observedConversationSize = (messages: ModelMessage[]): number => {
  let total = 0;
  for (const message of messages) {
    if (typeof message.content === "string") {
      total += message.content.length;
      continue;
    }
    for (const part of message.content) {
      if (part.type === "text") {
        total += part.text.length;
      } else if (part.type === "tool-call") {
        total += observedValueSize(part.input);
      } else if (part.type === "tool-result") {
        total += resultPayloadSize(part.output);
      }
    }
  }
  return total;
};

/**
 * Characters a pass would stop sending by clearing this result, net of the
 * marker that replaces it. Zero once it is already cleared, and zero for a
 * payload no larger than the marker — clearing that would grow the prompt
 * without freeing anything.
 */
const freedResultSize = (
  messages: ModelMessage[],
  location: ResultLocation,
): number => {
  const message = messages[location.messageIndex];
  if (message?.role !== "tool") return 0;
  const part = message.content[location.partIndex];
  if (part?.type !== "tool-result" || isCleared(part.output)) return 0;
  return reclaimedCharacters(
    resultPayloadSize(part.output),
    CLEARED_TOOL_RESULT_MARKER,
  );
};

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
 * Clears every clearable tool result EXCEPT the `keepRecent` most recent —
 * unconditionally, with no occupancy check and no target. `applyToolResultClearing`
 * below is the gated entry point every caller outside this module should use;
 * this is exported separately because the summary pass must clear everything it
 * is given (it protects its own window rather than the Chat's), and because the
 * "which results survive" rule can then be tested on its own from the
 * threshold rule.
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
  policy: Pick<ClearingPolicy, "keepRecent"> = DEFAULT_CLEARING_POLICY,
  isReadOnlyTool: (toolName: string) => boolean = NEVER_READ_ONLY,
): ModelMessage[] => {
  const locations = clearableResultLocations(messages, isReadOnlyTool);
  return clearResults(
    messages,
    locations,
    Math.max(0, locations.length - policy.keepRecent),
  );
};

/**
 * Clears the oldest clearable tool results until occupancy should have fallen
 * to `policy.targetFraction` of the declared window, assumed proportional to
 * the observed characters freed (see `clearingPrefixLength`). The
 * `keepRecent` newest are never touched, and the pass stops short if clearing
 * them all cannot reach the target.
 *
 * Pure, like `clearStaleToolResults`: no occupancy gate of its own, no stored
 * state. `applyToolResultClearing` is the gated caller.
 */
export const clearToolResultsToTarget = (
  messages: ModelMessage[],
  reading: {
    occupancy: number;
    contextWindow: number;
    conversationSize?: number;
  },
  policy: ClearingPolicy = DEFAULT_CLEARING_POLICY,
  isReadOnlyTool: (toolName: string) => boolean = NEVER_READ_ONLY,
): ModelMessage[] => {
  const locations = clearableResultLocations(messages, isReadOnlyTool);
  const count = clearingPrefixLength({
    itemSizes: locations.map((location) => freedResultSize(messages, location)),
    conversationSize:
      reading.conversationSize ?? observedConversationSize(messages),
    keepRecent: policy.keepRecent,
    occupancy: reading.occupancy,
    contextWindow: reading.contextWindow,
    targetFraction: policy.targetFraction,
    minBatch: policy.minBatch,
  });
  return clearResults(messages, locations, count);
};

/** What decides whether a clearing pass runs at all. */
export type OccupancyReading = {
  /** The input-token count the model call this policy is about to feed. */
  occupancy?: number;
  /** The Org Admin's declared Context window for this model (ADR-0018). */
  contextWindow?: number;
  /**
   * Observed characters of what the call sends, when the caller has already
   * measured them against a different message array. Tool-input clearing runs
   * after result clearing in the same step, so it is handed the pre-result-
   * clearing figure it shares with the result pass rather than measuring the
   * already-shrunk conversation again — the frontend mirror sizes both from the
   * one Transcript it has.
   */
  conversationSize?: number;
};

/**
 * The gated entry point: clears stale allowlisted tool results only once
 * occupancy has reached `thresholdFraction` of the declared window, and then
 * clears down to `targetFraction` in one batch.
 *
 * An undeclared window or an unknown occupancy clears nothing — no fallback,
 * no estimate, matching ADR-0018. Returns the same array reference in that
 * case (and below threshold), so a caller can assert "untouched" as "same
 * reference" rather than a deep comparison.
 */
export const applyToolResultClearing = (
  messages: ModelMessage[],
  reading: OccupancyReading,
  policy: ClearingPolicy = DEFAULT_CLEARING_POLICY,
  isReadOnlyTool: (toolName: string) => boolean = NEVER_READ_ONLY,
): ModelMessage[] => {
  const { occupancy, contextWindow } = reading;
  if (occupancy === undefined || contextWindow === undefined) return messages;
  if (occupancy / contextWindow < policy.thresholdFraction) return messages;
  return clearToolResultsToTarget(
    messages,
    { occupancy, contextWindow, conversationSize: reading.conversationSize },
    policy,
    isReadOnlyTool,
  );
};
