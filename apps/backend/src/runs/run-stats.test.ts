import { describe, it, expect } from "vitest";
import {
  accumulateStepStats,
  computeStats,
  type RunStep,
} from "./run-stats.ts";
import type { RunStats } from "./types.ts";

/**
 * The two usage folds (issue #734): the streaming accumulator and the
 * non-streaming `generateText` equivalent must carry the cached-input
 * breakdown the same way, summed across steps and never written as a key
 * where the Provider reported no cache detail.
 */

const step = (partial: Partial<RunStep> = {}): RunStep => ({
  toolCalls: [],
  ...partial,
});

describe("accumulateStepStats", () => {
  it("sums cached read and write counts across steps", () => {
    const stats: RunStats = {};
    accumulateStepStats(
      stats,
      step({
        usage: {
          inputTokens: 1_000,
          outputTokens: 30,
          inputTokenDetails: { cacheReadTokens: 700, cacheWriteTokens: 100 },
        },
      }),
    );
    accumulateStepStats(
      stats,
      step({
        usage: {
          inputTokens: 4_200,
          outputTokens: 70,
          inputTokenDetails: { cacheReadTokens: 2_000, cacheWriteTokens: 50 },
        },
      }),
    );

    expect(stats.inputTokens).toBe(5_200);
    expect(stats.outputTokens).toBe(100);
    expect(stats.cacheReadTokens).toBe(2_700);
    expect(stats.cacheWriteTokens).toBe(150);
  });

  it("sums cached read without a write where the Provider reports none", () => {
    const stats: RunStats = {};
    accumulateStepStats(
      stats,
      step({
        usage: {
          inputTokens: 1_000,
          outputTokens: 30,
          inputTokenDetails: { cacheReadTokens: 500 },
        },
      }),
    );

    expect(stats.cacheReadTokens).toBe(500);
    expect(stats.cacheWriteTokens).toBeUndefined();
  });

  it("recovers a summed read from a step reporting a real zero", () => {
    const stats: RunStats = {};
    accumulateStepStats(
      stats,
      step({
        usage: {
          inputTokens: 100,
          outputTokens: 0,
          inputTokenDetails: { cacheReadTokens: 900 },
        },
      }),
    );
    accumulateStepStats(
      stats,
      step({
        usage: {
          inputTokens: 50,
          outputTokens: 0,
          inputTokenDetails: { cacheReadTokens: 0 },
        },
      }),
    );

    // A reported 0 is a measurement and is kept, but the sum is unchanged by it.
    expect(stats.cacheReadTokens).toBe(900);
  });

  it("keeps no cache key for a Provider that reports no cache detail", () => {
    const stats: RunStats = {};
    accumulateStepStats(
      stats,
      step({ usage: { inputTokens: 1_000, outputTokens: 30 } }),
    );

    expect(stats.cacheReadTokens).toBeUndefined();
    expect(stats.cacheWriteTokens).toBeUndefined();
  });

  it("never erases an earlier step's sum when a later step reports nothing", () => {
    const stats: RunStats = {};
    accumulateStepStats(
      stats,
      step({
        usage: {
          inputTokens: 1_000,
          outputTokens: 30,
          inputTokenDetails: { cacheReadTokens: 700, cacheWriteTokens: 100 },
        },
      }),
    );
    // A billing sum only grows: this step reports no cache detail at all.
    accumulateStepStats(
      stats,
      step({ usage: { inputTokens: 4_200, outputTokens: 70 } }),
    );

    expect(stats.cacheReadTokens).toBe(700);
    expect(stats.cacheWriteTokens).toBe(100);
  });
});

describe("computeStats", () => {
  it("carries the summed cache breakdown off totalUsage", () => {
    const stats = computeStats({
      steps: [{ toolCalls: [], usage: { inputTokens: 1_000 } }],
      totalUsage: {
        inputTokens: 1_000,
        outputTokens: 30,
        inputTokenDetails: { cacheReadTokens: 900, cacheWriteTokens: 0 },
      },
    });

    expect(stats.inputTokens).toBe(1_000);
    expect(stats.cacheReadTokens).toBe(900);
    // A reported write of 0 is a measurement and is kept.
    expect(stats.cacheWriteTokens).toBe(0);
  });

  it("keeps no cache key when the Provider reports no cache detail", () => {
    const stats = computeStats({
      steps: [{ toolCalls: [], usage: { inputTokens: 1_000 } }],
      totalUsage: { inputTokens: 1_000, outputTokens: 30 },
    });

    expect(stats.cacheReadTokens).toBeUndefined();
    expect(stats.cacheWriteTokens).toBeUndefined();
  });
});
