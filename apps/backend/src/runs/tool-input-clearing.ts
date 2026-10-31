import type { ModelMessage } from "ai";
import {
  CLEARABLE_TOOL_INPUT_FIELDS,
  TOOL_INPUT_CLEARING_KEEP_RECENT,
  TOOL_RESULT_CLEARING_THRESHOLD,
} from "@platypus/schemas";
import type {
  ClearingPolicy,
  OccupancyReading,
} from "./tool-result-clearing.ts";

/**
 * Tool-input clearing (ADR-0018 Notes, issue #1722).
 *
 * Tool-result clearing's sibling for writes: replaces the bulky input fields
 * of an older, successful call to a core write tool
 * (`CLEARABLE_TOOL_INPUT_FIELDS`) in what one model call receives. Send-time
 * only, like result clearing — what is persisted and what a User sees keep
 * the full input. Wired in beside `applyToolResultClearing` in
 * `buildModelInvocation` (`./run-plan.ts`), so every Drive gets it.
 */

/**
 * What a cleared input field becomes. Unlike the result marker this points at
 * reading back: the write succeeded, so its effect is still there to read,
 * which is exactly why its input is safe to drop.
 */
export const CLEARED_TOOL_INPUT_MARKER =
  "[Tool input cleared: this content was removed from what was sent to the model to free up space in its context window. The call succeeded; read the file or widget back to see its current state.]";

export const DEFAULT_INPUT_CLEARING_POLICY: ClearingPolicy = {
  thresholdFraction: TOOL_RESULT_CLEARING_THRESHOLD,
  keepRecent: TOOL_INPUT_CLEARING_KEEP_RECENT,
};

type ToolOutput = { type: string; value?: unknown };

/**
 * Whether a result says its call succeeded: not an SDK error or denial, and
 * not the `{ error }` value a domain tool's `asToolResult` returns. A failed
 * call keeps its input — the model needs it to correct and retry.
 */
const succeeded = (output: ToolOutput): boolean => {
  if (output.type.startsWith("error-") || output.type === "execution-denied")
    return false;
  const { value } = output;
  return !(
    output.type === "json" &&
    typeof value === "object" &&
    value !== null &&
    "error" in value
  );
};

/** The `toolCallId`s whose result is present and successful. */
const succeededCallIds = (messages: ModelMessage[]): Set<string> => {
  const ids = new Set<string>();
  for (const message of messages) {
    if (message.role !== "tool") continue;
    for (const part of message.content) {
      if (part.type === "tool-result" && succeeded(part.output)) {
        ids.add(part.toolCallId);
      }
    }
  }
  return ids;
};

/** `input` with each of `fields` it holds set to the marker, or `input` itself if nothing changes. */
const clearFields = (input: unknown, fields: readonly string[]): unknown => {
  if (typeof input !== "object" || input === null) return input;
  const record = input as Record<string, unknown>;
  const stale = fields.filter(
    (field) => field in record && record[field] !== CLEARED_TOOL_INPUT_MARKER,
  );
  if (stale.length === 0) return input;
  return {
    ...record,
    ...Object.fromEntries(stale.map((f) => [f, CLEARED_TOOL_INPUT_MARKER])),
  };
};

/**
 * Clears the allowlisted input fields of every successful clearable call
 * EXCEPT the `keepRecent` most recent, once occupancy has reached
 * `thresholdFraction` of the declared window. An undeclared window or unknown
 * occupancy clears nothing, as with result clearing.
 *
 * Returns the same array reference when nothing changes, so a caller can tell
 * "untouched" from "rebuilt" by identity.
 */
export const applyToolInputClearing = (
  messages: ModelMessage[],
  reading: OccupancyReading,
  policy: ClearingPolicy = DEFAULT_INPUT_CLEARING_POLICY,
): ModelMessage[] => {
  const { occupancy, contextWindow } = reading;
  if (occupancy === undefined || contextWindow === undefined) return messages;
  if (occupancy / contextWindow < policy.thresholdFraction) return messages;

  const succeededIds = succeededCallIds(messages);
  const clearableIds: string[] = [];
  for (const message of messages) {
    if (message.role !== "assistant" || typeof message.content === "string")
      continue;
    for (const part of message.content) {
      if (
        part.type === "tool-call" &&
        CLEARABLE_TOOL_INPUT_FIELDS.has(part.toolName) &&
        succeededIds.has(part.toolCallId)
      ) {
        clearableIds.push(part.toolCallId);
      }
    }
  }
  const stale = new Set(
    clearableIds.slice(0, Math.max(0, clearableIds.length - policy.keepRecent)),
  );
  if (stale.size === 0) return messages;

  const cleared = messages.map((message) => {
    if (message.role !== "assistant" || typeof message.content === "string")
      return message;
    let changed = false;
    const content = message.content.map((part) => {
      if (part.type !== "tool-call" || !stale.has(part.toolCallId)) return part;
      const fields = CLEARABLE_TOOL_INPUT_FIELDS.get(part.toolName) ?? [];
      const input = clearFields(part.input, fields);
      if (input === part.input) return part;
      changed = true;
      return { ...part, input };
    });
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- set in a callback, which TS narrowing does not track
    return changed ? { ...message, content } : message;
  });
  return cleared.every((message, i) => message === messages[i])
    ? messages
    : cleared;
};
