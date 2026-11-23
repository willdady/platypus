import { describe, it, expect } from "vitest";
import { compositeSink } from "./composite-sink.ts";
import type { RunSink } from "../types.ts";

const recording = (name: string, calls: string[], failFinish = false) =>
  ({
    onStart: () => {
      calls.push(`${name}:start`);
      return Promise.resolve();
    },
    onResolved: () => Promise.resolve(),
    onProgress: () => Promise.resolve(),
    onFinish: () => {
      calls.push(`${name}:finish`);
      return failFinish
        ? Promise.reject(new Error(`${name} failed`))
        : Promise.resolve();
    },
  }) as RunSink;

const finish = {
  runId: "run-1",
  status: "succeeded" as const,
  messages: [],
  stats: {},
};

describe("compositeSink", () => {
  it("starts sinks in order and finishes them in reverse", async () => {
    const calls: string[] = [];
    const sink = compositeSink(recording("a", calls), recording("b", calls));

    await sink.onStart({ runId: "run-1", messages: [] });
    await sink.onFinish(finish);

    expect(calls).toEqual(["a:start", "b:start", "b:finish", "a:finish"]);
  });

  it("finishes every sink when one throws, then rethrows the first failure", async () => {
    const calls: string[] = [];
    const sink = compositeSink(
      recording("a", calls, true),
      recording("b", calls, true),
    );

    await expect(sink.onFinish(finish)).rejects.toThrow("b failed");
    expect(calls).toEqual(["b:finish", "a:finish"]);
  });
});
