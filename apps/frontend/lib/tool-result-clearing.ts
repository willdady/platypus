import {
  CLEARABLE_TOOL_INPUT_FIELDS,
  clearingEngaged,
  clearingPrefixLength,
  occupancyReadingsOf,
  TOOL_INPUT_CLEARING_KEEP_RECENT,
  TOOL_CLEARING_BATCH,
  TOOL_RESULT_CLEARING_KEEP_RECENT,
  TOOL_RESULT_CLEARING_THRESHOLD,
  type PlatypusUIMessage,
} from "@platypus/schemas";
import { isToolUIPart } from "ai";

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

function toolNameOf(part: ToolLikePart): string {
  return part.type === "dynamic-tool"
    ? (part.toolName ?? "")
    : isToolUIPart(part as never)
      ? part.type.slice("tool-".length)
      : "";
}

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

function isComplete(part: ToolLikePart): boolean {
  return part.state.startsWith("output-");
}

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

export function clearedToolCallIds(
  messages: readonly PlatypusUIMessage[],
  reading: { occupancy?: number; contextWindow?: number },
): ReadonlySet<string> {
  if (!clearingIsEngaged(messages, reading)) return NOTHING_CLEARED;

  const clearableToolNames = clearableToolNamesOf(messages);
  return clearedPrefixIds(
    messages,
    TOOL_RESULT_CLEARING_KEEP_RECENT,
    (part) => isComplete(part) && clearableToolNames.has(toolNameOf(part)),
  );
}

export function clearedInputToolCallIds(
  messages: readonly PlatypusUIMessage[],
  reading: { occupancy?: number; contextWindow?: number },
): ReadonlySet<string> {
  if (!clearingIsEngaged(messages, reading)) return NOTHING_CLEARED;

  return clearedPrefixIds(messages, TOOL_INPUT_CLEARING_KEEP_RECENT, (part) => {
    if (part.state !== "output-available") return false;
    if (!CLEARABLE_TOOL_INPUT_FIELDS.has(toolNameOf(part))) return false;
    const { output } = part;
    return !(
      typeof output === "object" &&
      output !== null &&
      "error" in output
    );
  });
}

function clearedPrefixIds(
  messages: readonly PlatypusUIMessage[],
  keepRecent: number,
  clearable: (part: ToolLikePart) => boolean,
): ReadonlySet<string> {
  const parts: ToolLikePart[] = [];
  for (const message of messages) {
    for (const part of message.parts ?? []) {
      if (isToolLikePart(part) && clearable(part)) parts.push(part);
    }
  }
  const count = clearingPrefixLength({
    itemCount: parts.length,
    keepRecent,
    batchSize: TOOL_CLEARING_BATCH,
  });
  if (count === 0) return NOTHING_CLEARED;
  return new Set(parts.slice(0, count).map((part) => part.toolCallId));
}
