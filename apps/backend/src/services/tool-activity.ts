import type { Tool } from "ai";
import { normalizeToolResult } from "./tool-result.ts";

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
 * The wrapper also normalizes value-returning results (issue #321): AI SDK v7
 * validates each tool result against a strict JSON-value schema on the next
 * step, and a raw Drizzle `Date` fails it. The async-iterable path is exempt —
 * its yields are streamed UI parts, not the value fed to the model.
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
          return (result as Promise<unknown>)
            .then(normalizeToolResult)
            .finally(finish);
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
        // Normalize before finish() so the sync path mirrors the promise path:
        // a throw (e.g. a BigInt in the result) happens before the "end" event.
        const normalized = normalizeToolResult(result);
        finish();
        return normalized;
      },
    };
  }
  return wrapped;
};
