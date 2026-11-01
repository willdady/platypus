import type { ModelMessage } from "ai";
import {
  CLEARABLE_TOOL_INPUT_FIELDS,
  CLEARED_TOOL_INPUT_MARKER,
  clearingPrefixLength,
  observedValueSize,
  reclaimedCharacters,
  TOOL_INPUT_CLEARING_KEEP_RECENT,
  TOOL_RESULT_CLEARING_MIN_BATCH,
  TOOL_RESULT_CLEARING_TARGET,
  TOOL_RESULT_CLEARING_THRESHOLD,
} from "@platypus/schemas";
import {
  observedConversationSize,
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
 * Same trigger/target hysteresis as result clearing, and the same shared
 * `clearingPrefixLength`: once engaged it clears as many of the oldest
 * successful writes as it takes to fall back to the target fraction, so the
 * cached prompt prefix survives the steps in between. Only what each call
 * actually wrote is measured — the fields the marker replaces — because that
 * is what clearing frees.
 */

export const DEFAULT_INPUT_CLEARING_POLICY: ClearingPolicy = {
  thresholdFraction: TOOL_RESULT_CLEARING_THRESHOLD,
  targetFraction: TOOL_RESULT_CLEARING_TARGET,
  keepRecent: TOOL_INPUT_CLEARING_KEEP_RECENT,
  minBatch: TOOL_RESULT_CLEARING_MIN_BATCH,
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
 * Characters a pass would stop sending by clearing this call's input, net of
 * the marker that replaces each field. Zero once it is already cleared, and
 * zero for a value no larger than the marker.
 */
const freedInputSize = (input: unknown, fields: readonly string[]): number => {
  if (typeof input !== "object" || input === null) return 0;
  const record = input as Record<string, unknown>;
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
};

/** One successful call to a clearable write tool, in transcript order. */
type ClearableCall = { toolCallId: string; freed: number };

const clearableCalls = (messages: ModelMessage[]): ClearableCall[] => {
  const succeededIds = succeededCallIds(messages);
  const calls: ClearableCall[] = [];
  for (const message of messages) {
    if (message.role !== "assistant" || typeof message.content === "string")
      continue;
    for (const part of message.content) {
      if (part.type !== "tool-call") continue;
      const fields = CLEARABLE_TOOL_INPUT_FIELDS.get(part.toolName);
      if (fields === undefined || !succeededIds.has(part.toolCallId)) continue;
      calls.push({
        toolCallId: part.toolCallId,
        freed: freedInputSize(part.input, fields),
      });
    }
  }
  return calls;
};

/**
 * Clears the allowlisted input fields of the oldest successful clearable calls
 * until occupancy should have fallen to `policy.targetFraction` of the declared
 * window, assumed proportional to the observed characters freed. The
 * `keepRecent` newest keep their input, and a pass that cannot reach the target
 * clears everything it may.
 *
 * Pure and ungated, like `clearToolResultsToTarget`; `applyToolInputClearing`
 * is the gated entry point.
 */
export const clearToolInputsToTarget = (
  messages: ModelMessage[],
  reading: {
    occupancy: number;
    contextWindow: number;
    conversationSize?: number;
  },
  policy: ClearingPolicy = DEFAULT_INPUT_CLEARING_POLICY,
): ModelMessage[] => {
  const calls = clearableCalls(messages);
  const count = clearingPrefixLength({
    itemSizes: calls.map((call) => call.freed),
    conversationSize:
      reading.conversationSize ?? observedConversationSize(messages),
    keepRecent: policy.keepRecent,
    occupancy: reading.occupancy,
    contextWindow: reading.contextWindow,
    targetFraction: policy.targetFraction,
    minBatch: policy.minBatch,
  });
  if (count === 0) return messages;
  const stale = new Set(calls.slice(0, count).map((call) => call.toolCallId));

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
 * The gated entry point: clears allowlisted input fields only once occupancy
 * has reached `thresholdFraction` of the declared window, and then clears down
 * to `targetFraction` in one batch. An undeclared window or unknown occupancy
 * clears nothing, as with result clearing.
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
  return clearToolInputsToTarget(
    messages,
    { occupancy, contextWindow, conversationSize: reading.conversationSize },
    policy,
  );
};
