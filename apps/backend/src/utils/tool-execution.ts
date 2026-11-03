import type { Tool } from "ai";

/** Whether `value` is a promise-like, without awaiting it. */
export const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  value != null && typeof (value as { then?: unknown }).then === "function";

/** Whether `value` is an async iterable — a streaming tool's result. */
export const isAsyncIterable = (
  value: unknown,
): value is AsyncIterable<unknown> =>
  value != null &&
  typeof (value as Record<symbol, unknown>)[Symbol.asyncIterator] ===
    "function";

/** Build the function that replaces one tool's `execute`. */
export type ToolExecuteWrapper = (
  runExecute: (args: unknown, options: unknown) => unknown,
  tool: Tool,
  toolName: string,
) => (args: unknown, options: unknown) => unknown;

/**
 * Wrap each tool's `execute` with `wrap`, leaving a tool that has none — a
 * Provider-executed tool — exactly as it was.
 *
 * The shared skeleton for the run's tool wrappers (result normalisation, the
 * result cap, activity events and the Tool gate's result stage): each owns what
 * happens to a result, not how every tool map is walked. `runExecute` is called
 * with the tool as its receiver, so a tool set may write `execute` as a method
 * reaching sibling state through `this`.
 */
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
