import type { Tool } from "ai";
import { logger } from "../logger.ts";
import {
  isAsyncIterable,
  isThenable,
  wrapToolExecutes,
} from "../utils/tool-execution.ts";
import { sliceWhole } from "../utils/storable.ts";

export const normalizeToolResult = (value: unknown): unknown => {
  const json = JSON.stringify(value);
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- JSON.stringify returns undefined for a function or symbol, though typed string
  if (json === undefined) return value;
  return JSON.parse(json);
};

export const MAX_TOOL_RESULT_CHARS = 200_000;

export const truncatedToolResultMarker = (length: number): string =>
  `[truncated: this tool result was ${length} characters long; only the first ${MAX_TOOL_RESULT_CHARS} were kept.]`;

export const capToolResult = (value: unknown, toolName: string): unknown => {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- JSON.stringify returns undefined for a function or symbol, though typed string
  if (text === undefined || text.length <= MAX_TOOL_RESULT_CHARS) return value;
  logger.warn(
    { toolName, length: text.length, limit: MAX_TOOL_RESULT_CHARS },
    "Tool result truncated",
  );
  return `${sliceWhole(text, MAX_TOOL_RESULT_CHARS)}\n${truncatedToolResultMarker(text.length)}`;
};

const mapToolResults = (
  tools: Record<string, Tool>,
  transform: (result: unknown, toolName: string) => unknown,
): Record<string, Tool> =>
  wrapToolExecutes(tools, (runExecute, tool, name) => (args, options) => {
    const result = runExecute.call(tool, args, options);
    if (isThenable(result)) return result.then((r) => transform(r, name));
    if (isAsyncIterable(result)) return result;
    return transform(result, name);
  });

export const normalizeToolResults = (
  tools: Record<string, Tool>,
): Record<string, Tool> => mapToolResults(tools, normalizeToolResult);

export const capToolResults = (
  tools: Record<string, Tool>,
): Record<string, Tool> => mapToolResults(tools, capToolResult);
