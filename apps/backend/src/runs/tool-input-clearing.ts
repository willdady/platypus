import type { ModelMessage } from "ai";
import {
  CLEARABLE_TOOL_INPUT_FIELDS,
  CLEARED_TOOL_INPUT_MARKER,
  clearingEngaged,
  clearingPrefixLength,
  TOOL_INPUT_CLEARING_KEEP_RECENT,
  TOOL_CLEARING_BATCH,
  TOOL_RESULT_CLEARING_THRESHOLD,
} from "@platypus/schemas";
import {
  type ClearingPolicy,
  type OccupancyReading,
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
 *
 * Same batched boundary and sticky gate as result clearing, through the same
 * `clearingPrefixLength` and `clearingEngaged`: once engaged it moves the
 * survivor boundary by a whole batch of successful writes, so the cached
 * prompt prefix survives the steps in between.
 */

export const DEFAULT_INPUT_CLEARING_POLICY: ClearingPolicy = {
  thresholdFraction: TOOL_RESULT_CLEARING_THRESHOLD,
  keepRecent: TOOL_INPUT_CLEARING_KEEP_RECENT,
  batchSize: TOOL_CLEARING_BATCH,
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

/** The `toolCallId`s of successful calls to a clearable write tool, in transcript order. */
const clearableCallIds = (messages: ModelMessage[]): string[] => {
  const succeededIds = succeededCallIds(messages);
  const ids: string[] = [];
  for (const message of messages) {
    if (message.role !== "assistant" || typeof message.content === "string")
      continue;
    for (const part of message.content) {
      if (part.type !== "tool-call") continue;
      if (!CLEARABLE_TOOL_INPUT_FIELDS.has(part.toolName)) continue;
      if (!succeededIds.has(part.toolCallId)) continue;
      ids.push(part.toolCallId);
    }
  }
  return ids;
};

/**
 * Clears the batched prefix of clearable calls' input — the oldest
 * `floor((n - keepRecent) / batchSize) * batchSize` — leaving the newest
 * `keepRecent` untouched. No occupancy check: `applyToolInputClearing` is the
 * gated entry point.
 */
export const clearStaleToolInputs = (
  messages: ModelMessage[],
  policy: Pick<
    ClearingPolicy,
    "keepRecent" | "batchSize"
  > = DEFAULT_INPUT_CLEARING_POLICY,
): ModelMessage[] => {
  const callIds = clearableCallIds(messages);
  const count = clearingPrefixLength({
    itemCount: callIds.length,
    keepRecent: policy.keepRecent,
    batchSize: policy.batchSize,
  });
  if (count === 0) return messages;
  const stale = new Set(callIds.slice(0, count));

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

/**
 * The gated entry point: clears a batch of allowlisted input fields once
 * clearing has engaged — the current reading is at `thresholdFraction` of the
 * declared window, or an earlier reading on the Active path was. An undeclared
 * window clears nothing, as with result clearing.
 *
 * Returns the same array reference when nothing changes, so a caller can tell
 * "untouched" from "rebuilt" by identity.
 */
export const applyToolInputClearing = (
  messages: ModelMessage[],
  reading: OccupancyReading,
  policy: ClearingPolicy = DEFAULT_INPUT_CLEARING_POLICY,
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
  return clearStaleToolInputs(messages, policy);
};
