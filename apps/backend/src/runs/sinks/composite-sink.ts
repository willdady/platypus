import type { RunSink } from "../types.ts";

/**
 * One run's lifecycle laid over several sinks: started in order and finished
 * in reverse, so a sink may reference rows an earlier one wrote. A Trigger
 * run's row comes first, then the Chat that keeps its Transcript (ADR-0044):
 * the Chat references the run, and is complete before the run reads as ended.
 * Every sink is finished, even when another's finish throws.
 */
export const compositeSink = (...sinks: RunSink[]): RunSink => ({
  async onStart(ctx) {
    for (const sink of sinks) await sink.onStart(ctx);
  },
  async onResolved(ctx) {
    for (const sink of sinks) await sink.onResolved(ctx);
  },
  async onProgress(ctx) {
    await Promise.all(sinks.map((sink) => sink.onProgress(ctx)));
  },
  async onFinish(ctx) {
    let failure: { error: unknown } | undefined;
    for (const sink of [...sinks].reverse()) {
      try {
        await sink.onFinish(ctx);
      } catch (error) {
        failure ??= { error };
      }
    }
    if (failure) throw failure.error;
  },
});
