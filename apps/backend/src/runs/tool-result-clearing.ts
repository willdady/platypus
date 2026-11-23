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

export type ClearingPolicy = {
  thresholdFraction: number;
  keepRecent: number;
  batchSize: number;
};

export const DEFAULT_CLEARING_POLICY: ClearingPolicy = {
  thresholdFraction: TOOL_RESULT_CLEARING_THRESHOLD,
  keepRecent: TOOL_RESULT_CLEARING_KEEP_RECENT,
  batchSize: TOOL_CLEARING_BATCH,
};

const NEVER_READ_ONLY = (): boolean => false;

export const isClearableToolName = (
  toolName: string,
  isReadOnlyTool: (toolName: string) => boolean = NEVER_READ_ONLY,
): boolean => CLEARABLE_TOOL_NAMES.has(toolName) || isReadOnlyTool(toolName);

type ResultLocation = { messageIndex: number; partIndex: number };

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

const isCleared = (output: ToolOutput): boolean =>
  output.type === "text" && output.value === CLEARED_TOOL_RESULT_MARKER;

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

export type OccupancyReading = {
  occupancy?: number;
  contextWindow?: number;
  priorReadings?: readonly (ContextOccupancyReading | null)[];
};

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
