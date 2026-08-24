import type { ModelMessage } from "ai";
import {
  CLEARABLE_TOOL_NAMES,
  TOOL_RESULT_CLEARING_KEEP_RECENT,
  TOOL_RESULT_CLEARING_THRESHOLD,
} from "@platypus/schemas";

/**
 * Tool-result clearing (ADR-0018 Notes, issue #524).
 *
 * Replaces the content of an older, allowlisted tool result in what one model
 * call receives, leaving the tool call and the tool-result part themselves in
 * place — only `output` changes. Send-time only: this never touches what is
 * persisted or what a User sees (`CONTEXT.md` — Tool-result clearing).
 *
 * A pure function over `ModelMessage[]` plus occupancy and the declared
 * window, exactly the shape `runs/tool-result-clearing.test.ts` exercises
 * without a run around it. Wired into every Drive from the one seam that
 * assembles their shared model arguments — see `buildModelInvocation` in
 * `./run-plan.ts` — so no Drive shape can opt out.
 */

/**
 * What a cleared result's content becomes. Deliberately says nothing about
 * re-running the tool: a model told to call it again would spend steps
 * re-fetching what it was just told to forget, and that holds regardless of
 * whether the tool happens to be one core has affirmative reason to believe
 * only reads (issue #626) — the marker's audience is the model, not an
 * Operator deciding what is safe to clear.
 */
export const CLEARED_TOOL_RESULT_MARKER =
  "[Tool result cleared: this content was removed from what was sent to the model to free up space in its context window. It is no longer available here.]";

export type ClearingPolicy = {
  /** Fraction of the declared Context window at which clearing engages. */
  thresholdFraction: number;
  /** How many of the most recent clearable tool results survive a pass. */
  keepRecent: number;
};

export const DEFAULT_CLEARING_POLICY: ClearingPolicy = {
  thresholdFraction: TOOL_RESULT_CLEARING_THRESHOLD,
  keepRecent: TOOL_RESULT_CLEARING_KEEP_RECENT,
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

/**
 * Clears every clearable tool result EXCEPT the `keepRecent` most recent —
 * unconditionally, with no occupancy check. `applyToolResultClearing` below is
 * the gated entry point every caller outside this module should use; this is
 * exported separately so the "which results survive" rule can be tested on
 * its own from the threshold rule.
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
  policy: ClearingPolicy = DEFAULT_CLEARING_POLICY,
  isReadOnlyTool: (toolName: string) => boolean = NEVER_READ_ONLY,
): ModelMessage[] => {
  const locations = clearableResultLocations(messages, isReadOnlyTool);
  const staleCount = Math.max(0, locations.length - policy.keepRecent);
  if (staleCount === 0) return messages;

  const stale = new Set(
    locations
      .slice(0, staleCount)
      .map((loc) => `${loc.messageIndex}:${loc.partIndex}`),
  );

  return messages.map((message, messageIndex) => {
    if (message.role !== "tool") return message;
    let changed = false;
    const content = message.content.map((part, partIndex) => {
      if (!stale.has(`${messageIndex}:${partIndex}`)) return part;
      changed = true;
      return {
        ...part,
        output: { type: "text" as const, value: CLEARED_TOOL_RESULT_MARKER },
      };
    });
    return changed ? { ...message, content } : message;
  });
};

/** What decides whether a clearing pass runs at all. */
export type OccupancyReading = {
  /** The input-token count the model call this policy is about to feed. */
  occupancy?: number;
  /** The Org Admin's declared Context window for this model (ADR-0018). */
  contextWindow?: number;
};

/**
 * The gated entry point: clears stale allowlisted tool results only once
 * occupancy has reached `thresholdFraction` of the declared window.
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
  return clearStaleToolResults(messages, policy, isReadOnlyTool);
};
