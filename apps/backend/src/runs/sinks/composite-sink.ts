import type { RunSink } from "../types.ts";

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
