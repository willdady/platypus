import { describe, it, expect } from "vitest";
import { responseMetrics } from "./response-metrics";

describe("responseMetrics", () => {
  it("returns undefined for a message with no metadata at all", () => {
    expect(responseMetrics(undefined)).toBeUndefined();
  });

  it("returns undefined when metadata carries none of the panel's fields", () => {
    expect(responseMetrics({ agentId: "agent-1" })).toBeUndefined();
  });

  it("reads Token usage, Preparation and Model straight off metadata", () => {
    expect(
      responseMetrics({
        tokenUsage: { inputTokens: 5_200, outputTokens: 100 },
        prepDurationMs: 842,
        modelDurationMs: 12_000,
      }),
    ).toEqual({
      tokenUsage: { inputTokens: 5_200, outputTokens: 100 },
      prepDurationMs: 842,
      modelDurationMs: 12_000,
      measuredToolDurationMs: undefined,
    });
  });

  it("passes the cached-input breakdown through with Token usage (issue #734)", () => {
    expect(
      responseMetrics({
        tokenUsage: {
          inputTokens: 5_200,
          outputTokens: 100,
          cacheReadTokens: 2_700,
          cacheWriteTokens: 150,
        },
      }),
    ).toEqual({
      tokenUsage: {
        inputTokens: 5_200,
        outputTokens: 100,
        cacheReadTokens: 2_700,
        cacheWriteTokens: 150,
      },
      prepDurationMs: undefined,
      modelDurationMs: undefined,
      measuredToolDurationMs: undefined,
    });
  });

  it("sums measured tool durations across every tool call", () => {
    const metrics = responseMetrics({
      modelDurationMs: 12_000,
      toolDurations: { "call-1": 300, "call-2": 700 },
    });

    expect(metrics?.measuredToolDurationMs).toBe(1_000);
  });

  it("keeps a zero measured tool duration rather than treating it as absent", () => {
    const metrics = responseMetrics({
      modelDurationMs: 12_000,
      toolDurations: { "call-1": 0 },
    });

    expect(metrics?.measuredToolDurationMs).toBe(0);
  });

  it("says nothing about tool time when the turn ran no local tools", () => {
    const metrics = responseMetrics({ modelDurationMs: 12_000 });

    expect(metrics?.measuredToolDurationMs).toBeUndefined();
  });

  it("shows an (i) for a message that carries only measured tool time", () => {
    // The legacy case: a message persisted before this change, which carries
    // #353's tool durations but neither Token usage nor a phase duration.
    const metrics = responseMetrics({
      toolDurations: { "call-1": 842 },
    });

    expect(metrics).toEqual({
      tokenUsage: undefined,
      prepDurationMs: undefined,
      modelDurationMs: undefined,
      measuredToolDurationMs: 842,
    });
  });
});
