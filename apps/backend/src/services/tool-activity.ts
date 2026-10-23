import type { Tool } from "ai";

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
): Record<string, Tool> => {
  const wrapped: Record<string, Tool> = {};
  for (const [name, t] of Object.entries(tools)) {
    const execute = (t as { execute?: unknown }).execute;
    if (typeof execute !== "function") {
      wrapped[name] = t;
      continue;
    }
    const runExecute = execute as (args: unknown, options: unknown) => unknown;
    wrapped[name] = {
      ...t,
      execute: (args: unknown, options: unknown) => {
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
          result = runExecute.call(t, args, options);
        } catch (err) {
          start();
          finish(calledAt);
          throw err;
        }
        // Async iterable / generator path (sub-agent tools). A generator's
        // `finally` only runs once it has been started, so `start` waits for
        // the first pull too: an iterable that is never read emits neither
        // event, and one that is read always emits both.
        if (
          result != null &&
          typeof (result as Record<symbol, unknown>)[Symbol.asyncIterator] ===
            "function"
        ) {
          const inner = result as AsyncIterable<unknown>;
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
        if (
          result != null &&
          typeof (result as { then?: unknown }).then === "function"
        ) {
          return (result as Promise<unknown>).finally(() => finish(calledAt));
        }
        finish(calledAt);
        return result;
      },
    };
  }
  return wrapped;
};
