import {
  CLEARABLE_TOOL_INPUT_FIELDS,
  clearingEngaged,
  clearingPrefixLength,
  occupancyReadingsOf,
  TOOL_INPUT_CLEARING_KEEP_RECENT,
  TOOL_RESULT_CLEARING_BATCH,
  TOOL_RESULT_CLEARING_KEEP_RECENT,
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
 * Shares its threshold, batch size, keep-recent constants and gate with the
 * backend via `@platypus/schemas`, so this and the actual clearing decision
 * can't silently disagree on those; only the "what was sent" mechanics differ,
 * because this reads UI messages rather than `ModelMessage[]`.
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

/** Whether a tool part has finished, successfully or not. */
function isComplete(part: ToolLikePart): boolean {
  return part.state.startsWith("output-");
}

/**
 * The shared gate, read from the same readings the backend gates on: the
 * current reading or any reading already on the Active path. A Delete or an
 * Alternative changes what this sees, exactly as it changes what the backend
 * sends.
 */
function clearingIsEngaged(
  messages: readonly PlatypusUIMessage[],
  reading: { occupancy?: number; contextWindow?: number },
): boolean {
  return clearingEngaged({
    occupancy: reading.occupancy,
    contextWindow: reading.contextWindow,
    thresholdFraction: TOOL_RESULT_CLEARING_THRESHOLD,
    priorReadings: occupancyReadingsOf(messages),
  });
}

/**
 * The `toolCallId`s of tool results this session's Chat meter would report as
 * cleared: clearable, complete (a failed read is still a read result the
 * backend clears), and the batched prefix of the oldest such results — the
 * same batch the backend would clear on the next turn's first call.
 *
 * Returns an empty set — clears nothing visually — the same way clearing
 * itself does nothing when the Context window is unknown, or when nothing has
 * engaged, and the SAME empty set every time, so the Transcript memo is not
 * defeated.
 */
export function clearedToolCallIds(
  messages: readonly PlatypusUIMessage[],
  reading: { occupancy?: number; contextWindow?: number },
): ReadonlySet<string> {
  if (!clearingIsEngaged(messages, reading)) return NOTHING_CLEARED;

  const clearableToolNames = clearableToolNamesOf(messages);
  const clearable: ToolLikePart[] = [];
  for (const message of messages) {
    for (const part of message.parts ?? []) {
      if (!isToolLikePart(part)) continue;
      if (!isComplete(part)) continue;
      if (!clearableToolNames.has(toolNameOf(part))) continue;
      clearable.push(part);
    }
  }

  const count = clearingPrefixLength({
    itemCount: clearable.length,
    keepRecent: TOOL_RESULT_CLEARING_KEEP_RECENT,
    batchSize: TOOL_RESULT_CLEARING_BATCH,
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
 * Same batched boundary and sticky gate as result clearing, so the two
 * mechanisms move their boundaries together and neither churns the cached
 * prefix on every step.
 *
 * Returns the same empty set whenever nothing is cleared, as above.
 */
export function clearedInputToolCallIds(
  messages: readonly PlatypusUIMessage[],
  reading: { occupancy?: number; contextWindow?: number },
): ReadonlySet<string> {
  if (!clearingIsEngaged(messages, reading)) return NOTHING_CLEARED;

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
    itemCount: clearable.length,
    keepRecent: TOOL_INPUT_CLEARING_KEEP_RECENT,
    batchSize: TOOL_RESULT_CLEARING_BATCH,
  });
  if (count === 0) return NOTHING_CLEARED;
  return new Set(clearable.slice(0, count).map((part) => part.toolCallId));
}
