import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mockDb, resetMockDb } from "../../test-utils.ts";

// extractFiles is exercised by storage/utils tests — pass through here so
// we can assert the messages handed to the db layer without file I/O.
vi.mock("../../storage/utils.ts", () => ({
  extractFiles: vi.fn((messages: any) => Promise.resolve(messages)),
}));

import { ChatSink } from "./chat-sink.ts";
import type { ResolvedRunPlan } from "../types.ts";

const planWithAgent: ResolvedRunPlan = {
  resolved: {
    agentId: "a1",
    providerId: "p1",
    modelId: "m1",
    // prepareChatTurn already nulls these for agent runs
    systemPrompt: undefined,
    temperature: undefined,
    topP: undefined,
    topK: undefined,
    seed: undefined,
    presencePenalty: undefined,
    frequencyPenalty: undefined,
  },
};

const planAdhoc: ResolvedRunPlan = {
  resolved: {
    agentId: undefined,
    providerId: "p1",
    modelId: "m1",
    systemPrompt: "raw prompt",
    temperature: 0.7,
    topP: 0.9,
    topK: 5,
    seed: 42,
    presencePenalty: 0.1,
    frequencyPenalty: 0.2,
  },
};

describe("ChatSink", () => {
  beforeEach(() => {
    resetMockDb();
  });

  describe("onStart", () => {
    it("flips an existing row to status=running", async () => {
      mockDb.returning.mockResolvedValueOnce([{ id: "chat-1" }]);

      const sink = new ChatSink({ orgId: "org-1", workspaceId: "ws-1" });
      await sink.onStart({ runId: "chat-1", messages: [] });

      expect(mockDb.update).toHaveBeenCalledTimes(1);
      const setArg = mockDb.set.mock.calls[0][0];
      expect(setArg.status).toBe("running");
      expect(mockDb.insert).not.toHaveBeenCalled();
    });

    it("inserts a stub row when none exists", async () => {
      mockDb.returning.mockResolvedValueOnce([]);

      const sink = new ChatSink({ orgId: "org-1", workspaceId: "ws-1" });
      await sink.onStart({ runId: "chat-2", messages: [] });

      expect(mockDb.update).toHaveBeenCalledTimes(1);
      expect(mockDb.insert).toHaveBeenCalledTimes(1);
      const inserted = mockDb.values.mock.calls[0][0];
      expect(inserted.id).toBe("chat-2");
      expect(inserted.status).toBe("running");
      expect(inserted.title).toBe("Untitled");
    });
  });

  describe("onProgress + FlushScheduler", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("coalesces rapid bumps into a single periodic flush", async () => {
      // onStart upsert
      mockDb.returning.mockResolvedValueOnce([{ id: "chat-3" }]);
      // First flush: update returns one row
      mockDb.returning.mockResolvedValueOnce([{ id: "chat-3" }]);

      const sink = new ChatSink({
        orgId: "org-1",
        workspaceId: "ws-1",
        flushIntervalMs: 100,
      });
      await sink.onStart({ runId: "chat-3", messages: [] });
      await sink.onResolved({ runId: "chat-3", plan: planWithAgent });

      const messages = [{ role: "assistant", parts: [] } as any];
      await sink.onProgress({ runId: "chat-3", messages, stats: {} });
      await sink.onProgress({ runId: "chat-3", messages, stats: {} });
      await sink.onProgress({ runId: "chat-3", messages, stats: {} });

      // No flush fired yet — onStart was the only update so far
      expect(mockDb.update).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(100);

      // FlushScheduler triggered one update with status=running + messages
      expect(mockDb.update).toHaveBeenCalledTimes(2);
      const flushSet = mockDb.set.mock.calls[1][0];
      expect(flushSet.status).toBe("running");
      expect(flushSet.messages).toEqual(messages);
      expect(flushSet.agentId).toBe("a1");
    });

    it("dispose cancels pending flush in onFinish (no extra writes)", async () => {
      mockDb.returning.mockResolvedValueOnce([{ id: "chat-d" }]); // onStart
      mockDb.returning.mockResolvedValueOnce([{ id: "chat-d" }]); // onFinish

      const sink = new ChatSink({
        orgId: "org-1",
        workspaceId: "ws-1",
        flushIntervalMs: 1000,
      });
      await sink.onStart({ runId: "chat-d", messages: [] });
      await sink.onResolved({ runId: "chat-d", plan: planWithAgent });
      await sink.onProgress({ runId: "chat-d", messages: [], stats: {} });

      await sink.onFinish({
        runId: "chat-d",
        status: "succeeded",
        messages: [],
        stats: {},
      });

      const callsBefore = mockDb.update.mock.calls.length;
      await vi.advanceTimersByTimeAsync(2000);
      // No additional update calls after onFinish
      expect(mockDb.update.mock.calls.length).toBe(callsBefore);
    });
  });

  describe("onFinish — agent path", () => {
    it("writes status=succeeded with agentId and per-call generation fields nulled", async () => {
      mockDb.returning.mockResolvedValueOnce([{ id: "chat-1" }]); // onStart
      mockDb.returning.mockResolvedValueOnce([{ id: "chat-1" }]); // onFinish

      const sink = new ChatSink({ orgId: "org-1", workspaceId: "ws-1" });
      await sink.onStart({ runId: "chat-1", messages: [] });
      await sink.onResolved({ runId: "chat-1", plan: planWithAgent });
      await sink.onFinish({
        runId: "chat-1",
        status: "succeeded",
        messages: [{ role: "user", parts: [] } as any],
        stats: {},
      });

      // 2 updates: onStart status flip + onFinish full write
      expect(mockDb.update).toHaveBeenCalledTimes(2);
      const finishSet = mockDb.set.mock.calls[1][0];
      expect(finishSet.status).toBe("succeeded");
      expect(finishSet.agentId).toBe("a1");
      expect(finishSet.providerId).toBeNull();
      expect(finishSet.modelId).toBeNull();
      expect(finishSet.systemPrompt).toBeNull();
      expect(finishSet.temperature).toBeNull();
      expect(finishSet.topP).toBeNull();
      expect(finishSet.seed).toBeNull();
      expect(finishSet.presencePenalty).toBeNull();
      expect(finishSet.frequencyPenalty).toBeNull();
    });

    it("falls back to insert when finish update affects zero rows", async () => {
      mockDb.returning.mockResolvedValueOnce([{ id: "chat-2" }]); // onStart
      mockDb.returning.mockResolvedValueOnce([]); // onFinish update misses

      const sink = new ChatSink({ orgId: "org-1", workspaceId: "ws-1" });
      await sink.onStart({ runId: "chat-2", messages: [] });
      await sink.onResolved({ runId: "chat-2", plan: planWithAgent });
      await sink.onFinish({
        runId: "chat-2",
        status: "succeeded",
        messages: [],
        stats: {},
      });

      expect(mockDb.insert).toHaveBeenCalledTimes(1);
      const insertedValues = mockDb.values.mock.calls.at(-1)![0];
      expect(insertedValues.id).toBe("chat-2");
      expect(insertedValues.workspaceId).toBe("ws-1");
      expect(insertedValues.title).toBe("Untitled");
      expect(insertedValues.status).toBe("succeeded");
      expect(insertedValues.agentId).toBe("a1");
    });

    it("writes status=cancelled when the run was cancelled", async () => {
      mockDb.returning.mockResolvedValueOnce([{ id: "chat-c" }]); // onStart
      mockDb.returning.mockResolvedValueOnce([{ id: "chat-c" }]); // onFinish

      const sink = new ChatSink({ orgId: "org-1", workspaceId: "ws-1" });
      await sink.onStart({ runId: "chat-c", messages: [] });
      await sink.onResolved({ runId: "chat-c", plan: planWithAgent });
      await sink.onFinish({
        runId: "chat-c",
        status: "cancelled",
        messages: [],
        stats: {},
      });

      const finishSet = mockDb.set.mock.calls[1][0];
      expect(finishSet.status).toBe("cancelled");
    });
  });

  describe("onFinish — adhoc path", () => {
    it("persists provider/model and the resolved generation config", async () => {
      mockDb.returning.mockResolvedValueOnce([{ id: "chat-3" }]); // onStart
      mockDb.returning.mockResolvedValueOnce([{ id: "chat-3" }]); // onFinish

      const sink = new ChatSink({ orgId: "org-1", workspaceId: "ws-1" });
      await sink.onStart({ runId: "chat-3", messages: [] });
      await sink.onResolved({ runId: "chat-3", plan: planAdhoc });
      await sink.onFinish({
        runId: "chat-3",
        status: "succeeded",
        messages: [],
        stats: {},
      });

      const finishSet = mockDb.set.mock.calls[1][0];
      expect(finishSet.agentId).toBeNull();
      expect(finishSet.providerId).toBe("p1");
      expect(finishSet.modelId).toBe("m1");
      expect(finishSet.systemPrompt).toBe("raw prompt");
      expect(finishSet.temperature).toBe(0.7);
      expect(finishSet.topP).toBe(0.9);
      expect(finishSet.topK).toBe(5);
      expect(finishSet.seed).toBe(42);
      expect(finishSet.presencePenalty).toBe(0.1);
      expect(finishSet.frequencyPenalty).toBe(0.2);
    });
  });

  describe("onFinish — no plan (resolution failed)", () => {
    it("updates only the status on the existing onStart row", async () => {
      mockDb.returning.mockResolvedValueOnce([{ id: "chat-x" }]); // onStart

      const sink = new ChatSink({ orgId: "org-1", workspaceId: "ws-1" });
      await sink.onStart({ runId: "chat-x", messages: [] });
      // No onResolved — simulating prepareChatTurn failing
      await sink.onFinish({
        runId: "chat-x",
        status: "failed",
        messages: [],
        stats: {},
      });

      // 2 updates: onStart upsert + onFinish status-only update
      expect(mockDb.update).toHaveBeenCalledTimes(2);
      const finishSet = mockDb.set.mock.calls[1][0];
      expect(finishSet.status).toBe("failed");
      expect(finishSet.messages).toBeUndefined();
      expect(mockDb.insert).not.toHaveBeenCalled();
    });
  });
});
