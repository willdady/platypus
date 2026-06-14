import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mockDb, resetMockDb } from "../../test-utils.ts";
import { TriggerSink } from "./trigger-sink.ts";
import type { ResolvedRunPlan } from "../types.ts";

const plan: ResolvedRunPlan = {
  resolved: {
    agentId: "a1",
    providerId: "p1",
    modelId: "m1",
    contextWindow: 128000,
    contextWindowIsDefault: false,
  },
};

describe("TriggerSink", () => {
  beforeEach(() => {
    resetMockDb();
  });

  describe("onStart", () => {
    it("inserts a triggerRun row with status running and event metadata", async () => {
      const sink = new TriggerSink({
        triggerId: "trigger-1",
        eventType: "card.created",
        eventData: { cardId: "c1" },
      });

      await sink.onStart({ runId: "run-1", messages: [] });

      expect(mockDb.insert).toHaveBeenCalledTimes(1);
      const inserted = mockDb.values.mock.calls[0][0] as Record<
        string,
        unknown
      >;
      expect(inserted.id).toBe("run-1");
      expect(inserted.triggerId).toBe("trigger-1");
      expect(inserted.status).toBe("running");
      expect(inserted.eventType).toBe("card.created");
      expect(inserted.eventData).toEqual({ cardId: "c1" });
      expect(inserted.startedAt).toBeInstanceOf(Date);
      expect(inserted.createdAt).toBeInstanceOf(Date);
    });

    it("inserts a row with null event metadata when no event context is provided", async () => {
      const sink = new TriggerSink({ triggerId: "trigger-1" });

      await sink.onStart({ runId: "run-1", messages: [] });

      const inserted = mockDb.values.mock.calls[0][0] as Record<
        string,
        unknown
      >;
      expect(inserted.eventType).toBeNull();
      expect(inserted.eventData).toBeNull();
    });
  });

  describe("onResolved", () => {
    it("does not touch the DB", async () => {
      const sink = new TriggerSink({ triggerId: "trigger-1" });

      await sink.onResolved({ runId: "run-1", plan });

      expect(mockDb.update).not.toHaveBeenCalled();
      expect(mockDb.insert).not.toHaveBeenCalled();
    });
  });

  describe("onProgress + FlushScheduler", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("writes incremental stats to the triggerRun row on the flush interval", async () => {
      const sink = new TriggerSink({
        triggerId: "trigger-1",
        flushIntervalMs: 100,
      });
      await sink.onStart({ runId: "run-1", messages: [] });
      await sink.onResolved({ runId: "run-1", plan });

      // Multiple bumps within the window — coalesce to one write
      await sink.onProgress({
        runId: "run-1",
        messages: [],
        stats: {
          steps: 1,
          toolCalls: [{ name: "t1", count: 1 }],
          inputTokens: 10,
          outputTokens: 5,
        },
      });
      await sink.onProgress({
        runId: "run-1",
        messages: [],
        stats: {
          steps: 2,
          toolCalls: [{ name: "t1", count: 2 }],
          inputTokens: 20,
          outputTokens: 10,
        },
      });

      expect(mockDb.update).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(100);

      expect(mockDb.update).toHaveBeenCalledTimes(1);
      const setArg = mockDb.set.mock.calls[0][0] as Record<string, unknown>;
      expect(setArg.stats).toEqual({
        steps: 2,
        toolCalls: [{ name: "t1", count: 2 }],
        inputTokens: 20,
        outputTokens: 10,
      });
      // No status flip on incremental writes — terminal status is for onFinish
      expect(setArg.status).toBeUndefined();
    });

    it("does not write when no steps have been observed yet", async () => {
      const sink = new TriggerSink({
        triggerId: "trigger-1",
        flushIntervalMs: 100,
      });
      await sink.onStart({ runId: "run-1", messages: [] });
      await sink.onProgress({ runId: "run-1", messages: [], stats: {} });
      await vi.advanceTimersByTimeAsync(200);

      // No update call — stats with steps==null are skipped
      expect(mockDb.update).not.toHaveBeenCalled();
    });
  });

  describe("onFinish", () => {
    it("maps a succeeded run to status 'success' with stats", async () => {
      const sink = new TriggerSink({ triggerId: "trigger-1" });

      await sink.onFinish({
        runId: "run-1",
        status: "succeeded",
        messages: [],
        stats: {
          steps: 2,
          toolCalls: [{ name: "tool1", count: 3 }],
          inputTokens: 100,
          outputTokens: 50,
        },
      });

      expect(mockDb.update).toHaveBeenCalledTimes(1);
      const setArg = mockDb.set.mock.calls[0][0] as Record<string, unknown>;
      expect(setArg.status).toBe("success");
      expect(setArg.errorMessage).toBeNull();
      expect(setArg.stats).toEqual({
        steps: 2,
        toolCalls: [{ name: "tool1", count: 3 }],
        inputTokens: 100,
        outputTokens: 50,
      });
      expect(setArg.completedAt).toBeInstanceOf(Date);
    });

    it("maps a failed run to status 'failed' with the error message", async () => {
      const sink = new TriggerSink({ triggerId: "trigger-1" });

      await sink.onFinish({
        runId: "run-1",
        status: "failed",
        messages: [],
        stats: {},
        error: new Error("Model exploded"),
      });

      const setArg = mockDb.set.mock.calls[0][0] as Record<string, unknown>;
      expect(setArg.status).toBe("failed");
      expect(setArg.errorMessage).toBe("Model exploded");
      expect(setArg.stats).toBeNull();
      expect(setArg.completedAt).toBeInstanceOf(Date);
    });

    it("treats cancelled runs as failed in the persistence schema", async () => {
      // The triggerRun schema has only success | failed | running | pending,
      // so cancellation is recorded as failed for now. PR #3 may revisit.
      const sink = new TriggerSink({ triggerId: "trigger-1" });

      await sink.onFinish({
        runId: "run-1",
        status: "cancelled",
        messages: [],
        stats: {},
      });

      const setArg = mockDb.set.mock.calls[0][0] as Record<string, unknown>;
      expect(setArg.status).toBe("failed");
    });

    it("only writes stats when steps are present (succeeded with no stats yields null)", async () => {
      const sink = new TriggerSink({ triggerId: "trigger-1" });

      await sink.onFinish({
        runId: "run-1",
        status: "succeeded",
        messages: [],
        stats: {},
      });

      const setArg = mockDb.set.mock.calls[0][0] as Record<string, unknown>;
      expect(setArg.stats).toBeNull();
    });
  });
});
