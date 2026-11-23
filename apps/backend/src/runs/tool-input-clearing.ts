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

export const DEFAULT_INPUT_CLEARING_POLICY: ClearingPolicy = {
  thresholdFraction: TOOL_RESULT_CLEARING_THRESHOLD,
  keepRecent: TOOL_INPUT_CLEARING_KEEP_RECENT,
  batchSize: TOOL_CLEARING_BATCH,
};

type ToolOutput = { type: string; value?: unknown };

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
