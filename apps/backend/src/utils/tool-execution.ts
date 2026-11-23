import type { Tool } from "ai";

export const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  value != null && typeof (value as { then?: unknown }).then === "function";

export const isAsyncIterable = (
  value: unknown,
): value is AsyncIterable<unknown> =>
  value != null &&
  typeof (value as Record<symbol, unknown>)[Symbol.asyncIterator] ===
    "function";

export type ToolExecuteWrapper = (
  runExecute: (args: unknown, options: unknown) => unknown,
  tool: Tool,
  toolName: string,
) => (args: unknown, options: unknown) => unknown;

export const wrapToolExecutes = (
  tools: Record<string, Tool>,
  wrap: ToolExecuteWrapper,
): Record<string, Tool> => {
  const wrapped: Record<string, Tool> = {};
  for (const [name, tool] of Object.entries(tools)) {
    const execute = (tool as { execute?: unknown }).execute;
    if (typeof execute !== "function") {
      wrapped[name] = tool;
      continue;
    }
    wrapped[name] = {
      ...tool,
      execute: wrap(
        execute as (args: unknown, options: unknown) => unknown,
        tool,
        name,
      ),
    };
  }
  return wrapped;
};
