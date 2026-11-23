import type { Tool } from "ai";
import {
  isAsyncIterable,
  isThenable,
  wrapToolExecutes,
} from "../utils/tool-execution.ts";

export type ToolActivityEvent = {
  phase: "start" | "end";
  toolName: string;
  durationMs?: number;
};

export const wrapToolsWithActivity = (
  tools: Record<string, Tool>,
  onActivity: (event: ToolActivityEvent) => void,
): Record<string, Tool> =>
  wrapToolExecutes(tools, (runExecute, tool, name) => (args, options) => {
    const calledAt = Date.now();
    const start = () => onActivity({ phase: "start", toolName: name });
    const finish = (startedAt: number) => {
      onActivity({
        phase: "end",
        toolName: name,
        durationMs: Date.now() - startedAt,
      });
    };
    let result: unknown;
    try {
      result = runExecute.call(tool, args, options);
    } catch (err) {
      start();
      finish(calledAt);
      throw err;
    }
    if (isAsyncIterable(result)) {
      const inner = result;
      return (async function* () {
        const pulledAt = Date.now();
        start();
        try {
          for await (const part of inner) {
            yield part;
          }
        } finally {
          finish(pulledAt);
        }
      })();
    }
    start();
    if (isThenable(result)) {
      return (result as Promise<unknown>).finally(() => finish(calledAt));
    }
    finish(calledAt);
    return result;
  });
