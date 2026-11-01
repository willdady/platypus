import {
  CLEARABLE_TOOL_INPUT_FIELDS,
  CLEARED_TOOL_INPUT_MARKER,
  CLEARED_TOOL_RESULT_MARKER,
  clearingPrefixLength,
  observedValueSize,
  reclaimedCharacters,
  TOOL_INPUT_CLEARING_KEEP_RECENT,
  TOOL_RESULT_CLEARING_KEEP_RECENT,
  TOOL_RESULT_CLEARING_MIN_BATCH,
  TOOL_RESULT_CLEARING_TARGET,
  TOOL_RESULT_CLEARING_THRESHOLD,
  type PlatypusUIMessage,
} from "@platypus/schemas";
import { isToolUIPart } from "ai";

/**
 * The client-side mirror of Tool-result clearing's "which results are stale"
 * rule (ADR-0018 Notes, `apps/backend/src/runs/tool-result-clearing.ts`, issue
 * #524; ADR-0041) — derived, never persisted, so it can never drift into a
 * stored lie about a message that a later turn changes the answer for.
 *
 * Shares its threshold, target, keep-recent constants and batch arithmetic
 * with the backend via `@platypus/schemas`, so this and the actual clearing
 * decision can't silently disagree on those; only the "what was sent"
 * mechanics differ, because this reads UI messages rather than
 * `ModelMessage[]`.
 *
 * The batch is sized from observed characters, matching the backend's
 * measurement of what it would stop sending: text, tool-call inputs and
 * tool-result payloads, with reasoning and file parts left out on both sides.
 *
 * Holds no clearability policy of its own (ADR-0021, issue #626): an MCP
 * tool's clearability is only knowable by connecting to it, which only the
 * backend has done, so the core allowlist has no client-side counterpart.
 * Instead this unions `ChatMessageMetadata.readOnlyToolNames` across every
 * assistant message in the Transcript — the turn's clearable Tool names among
 * the ones it actually called.
 */

/**
 * The one "nothing is cleared" answer. The Transcript memo compares this value
 * by identity, so returning a fresh empty `Set` per call re-rendered every
 * message on every streamed token — the normal case is unknown occupancy, so
 * this is the answer nearly every render returns (issue #869).
 */
const NOTHING_CLEARED: ReadonlySet<string> = new Set();

type ToolLikePart = {
  type: string;
  toolCallId: string;
  state: string;
  toolName?: string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
};

function isToolLikePart(part: unknown): part is ToolLikePart {
  return (
    typeof part === "object" &&
    part !== null &&
    "toolCallId" in part &&
    "state" in part &&
    "type" in part
  );
}

/** The bare tool name a UI message part carries, static or dynamic. */
function toolNameOf(part: ToolLikePart): string {
  return part.type === "dynamic-tool"
    ? (part.toolName ?? "")
    : isToolUIPart(part as never)
      ? part.type.slice("tool-".length)
      : "";
}

/** Every clearable Tool name any assistant message in `messages` has reported. */
function clearableToolNamesOf(
  messages: readonly PlatypusUIMessage[],
): ReadonlySet<string> {
  const names = new Set<string>();
  for (const message of messages) {
    for (const name of message.metadata?.readOnlyToolNames ?? []) {
      names.add(name);
    }
  }
  return names;
}

/**
 * Observed size of what a completed UI message sends: text, and each tool
 * part's input and output. The backend measures the same three things from
 * `ModelMessage` parts, so a batch decision made here matches the next turn's
 * first model call.
 */
function observedConversationSize(
  messages: readonly PlatypusUIMessage[],
): number {
  let total = 0;
  for (const message of messages) {
    for (const part of message.parts ?? []) {
      if (isToolLikePart(part)) {
        total += observedValueSize(part.input);
        if (part.state === "output-available") {
          total += observedValueSize(part.output);
        } else if (part.errorText !== undefined) {
          total += part.errorText.length;
        }
        continue;
      }
      if (part.type === "text") total += part.text.length;
    }
  }
  return total;
}

/** Characters clearing this result would stop sending, net of its marker. */
function freedResultSize(part: ToolLikePart): number {
  if (part.state !== "output-available") return 0;
  return reclaimedCharacters(
    observedValueSize(part.output),
    CLEARED_TOOL_RESULT_MARKER,
  );
}

/** Characters clearing this call's input would stop sending, net of its marker. */
function freedInputSize(part: ToolLikePart): number {
  if (part.state !== "output-available") return 0;
  const fields = CLEARABLE_TOOL_INPUT_FIELDS.get(toolNameOf(part));
  if (fields === undefined) return 0;
  if (typeof part.input !== "object" || part.input === null) return 0;
  const record = part.input as Record<string, unknown>;
  let freed = 0;
  for (const field of fields) {
    const value = record[field];
    if (value === undefined || value === CLEARED_TOOL_INPUT_MARKER) continue;
    freed += reclaimedCharacters(
      observedValueSize(value),
      CLEARED_TOOL_INPUT_MARKER,
    );
  }
  return freed;
}

/**
 * The `toolCallId`s of tool results this session's Chat meter would report as
 * cleared: clearable, output-available, and enough of the oldest such results
 * to bring occupancy back to `TOOL_RESULT_CLEARING_TARGET` once the shared
 * threshold has engaged — the same batch the backend would clear on the next
 * turn's first call.
 *
 * Returns an empty set — clears nothing visually — the same way clearing
 * itself does nothing when occupancy or the Context window is unknown, and the
 * SAME empty set every time, so the Transcript memo is not defeated.
 */
export function clearedToolCallIds(
  messages: readonly PlatypusUIMessage[],
  reading: { occupancy?: number; contextWindow?: number },
): ReadonlySet<string> {
  const { occupancy, contextWindow } = reading;
  if (occupancy === undefined || contextWindow === undefined) {
    return NOTHING_CLEARED;
  }
  if (occupancy / contextWindow < TOOL_RESULT_CLEARING_THRESHOLD) {
    return NOTHING_CLEARED;
  }

  const clearableToolNames = clearableToolNamesOf(messages);
  const clearable: ToolLikePart[] = [];
  for (const message of messages) {
    for (const part of message.parts ?? []) {
      if (!isToolLikePart(part)) continue;
      if (part.state !== "output-available") continue;
      if (!clearableToolNames.has(toolNameOf(part))) continue;
      clearable.push(part);
    }
  }

  const count = clearingPrefixLength({
    itemSizes: clearable.map(freedResultSize),
    conversationSize: observedConversationSize(messages),
    keepRecent: TOOL_RESULT_CLEARING_KEEP_RECENT,
    occupancy,
    contextWindow,
    targetFraction: TOOL_RESULT_CLEARING_TARGET,
    minBatch: TOOL_RESULT_CLEARING_MIN_BATCH,
  });
  if (count === 0) return NOTHING_CLEARED;
  return new Set(clearable.slice(0, count).map((part) => part.toolCallId));
}

/**
 * The client-side mirror of Tool-input clearing (ADR-0018 Notes, issue #1722,
 * `apps/backend/src/runs/tool-input-clearing.ts`): the `toolCallId`s of
 * successful calls to a core write tool whose input the NEXT model call would
 * no longer receive in full. Unlike results, the allowlist is core-only, so it
 * is read straight from `@platypus/schemas`.
 *
 * Same trigger/target batch as result clearing, so the two mechanisms move
 * their boundaries together and neither churns the cached prefix on every
 * step.
 *
 * Returns the same empty set whenever nothing is cleared, as above.
 */
export function clearedInputToolCallIds(
  messages: readonly PlatypusUIMessage[],
  reading: { occupancy?: number; contextWindow?: number },
): ReadonlySet<string> {
  const { occupancy, contextWindow } = reading;
  if (occupancy === undefined || contextWindow === undefined) {
    return NOTHING_CLEARED;
  }
  if (occupancy / contextWindow < TOOL_RESULT_CLEARING_THRESHOLD) {
    return NOTHING_CLEARED;
  }

  const clearable: ToolLikePart[] = [];
  for (const message of messages) {
    for (const part of message.parts ?? []) {
      if (!isToolLikePart(part)) continue;
      if (part.state !== "output-available") continue;
      if (!CLEARABLE_TOOL_INPUT_FIELDS.has(toolNameOf(part))) continue;
      // A domain tool's `{ error }` result is a failure the model must retry.
      const { output } = part;
      if (typeof output === "object" && output !== null && "error" in output) {
        continue;
      }
      clearable.push(part);
    }
  }

  const count = clearingPrefixLength({
    itemSizes: clearable.map(freedInputSize),
    conversationSize: observedConversationSize(messages),
    keepRecent: TOOL_INPUT_CLEARING_KEEP_RECENT,
    occupancy,
    contextWindow,
    targetFraction: TOOL_RESULT_CLEARING_TARGET,
    minBatch: TOOL_RESULT_CLEARING_MIN_BATCH,
  });
  if (count === 0) return NOTHING_CLEARED;
  return new Set(clearable.slice(0, count).map((part) => part.toolCallId));
}
