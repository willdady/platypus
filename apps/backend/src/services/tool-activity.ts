import type { Tool } from "ai";
import {
  isAsyncIterable,
  isThenable,
  wrapToolExecutes,
} from "../utils/tool-execution.ts";

/**
 * Per-tool-call lifecycle event surfaced to the run lifecycle.
 *
 * `durationMs` is only set on `"end"` events. The run driver logs both phases
 * and, more importantly, holds the run's per-step stall timer down between
 * them: a tool that is still executing is not a stalled step, however long it
 * takes (`RunHandle.holdStep`).
 */
export type ToolActivityEvent = {
  phase: "start" | "end";
  toolName: string;
  durationMs?: number;
};

/**
 * Wraps each tool's `execute` so the surrounding run sees a `start` event as
 * it runs and exactly one matching `end` event once it settles — on every exit
 * path, including a synchronous throw and a consumer that drains, returns from
 * or throws into an async generator.
 *
 * Activity events and nothing else. Result normalization (issue #321) used to
 * ride here too, which mounted a correctness guarantee on an optional
 * observability parameter: a turn with no `onActivity` got no normalization. It
 * now happens unconditionally at the loader seam — see `normalizeToolResults`.
 *
 * Lives outside `chat-execution.ts` because both the parent turn and a
 * sub-agent's own tool set need it, and the sub-agent tool builder is imported
 * by `chat-execution.ts`.
 */
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
    // Async iterable / generator path (sub-agent tools). A generator's
    // `finally` only runs once it has been started, so `start` waits for
    // the first pull too: an iterable that is never read emits neither
    // event, and one that is read always emits both.
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
