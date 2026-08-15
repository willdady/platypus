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
 * Wraps each tool's `execute` so the surrounding run sees a `start` event
 * before it runs and an `end` event once it settles — on every exit path,
 * including a synchronous throw and a consumer that drains an async generator.
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
        const startedAt = Date.now();
        onActivity({ phase: "start", toolName: name });
        const finish = () => {
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
          finish();
          throw err;
        }
        if (
          result != null &&
          typeof (result as { then?: unknown }).then === "function"
        ) {
          return (result as Promise<unknown>).finally(finish);
        }
        // Async iterable / generator path (sub-agent tools). Wrap it so the
        // "end" event fires once the consumer drains the iterator.
        if (
          result != null &&
          typeof (result as Record<symbol, unknown>)[Symbol.asyncIterator] ===
            "function"
        ) {
          const inner = result as AsyncIterable<unknown>;
          return (async function* () {
            try {
              for await (const part of inner) {
                yield part;
              }
            } finally {
              finish();
            }
          })();
        }
        finish();
        return result;
      },
    };
  }
  return wrapped;
};
