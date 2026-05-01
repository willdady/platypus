import { describe, it, expect, beforeEach, vi } from "vitest";
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

  describe("non-terminal lifecycle", () => {
    it("onStart, onResolved, and onProgress do not touch the DB", async () => {
      const sink = new ChatSink({ orgId: "org-1", workspaceId: "ws-1" });
      await sink.onStart({ runId: "chat-1" });
      await sink.onResolved({ runId: "chat-1", plan: planWithAgent });
      await sink.onProgress({ runId: "chat-1", messages: [], stats: {} });
      expect(mockDb.update).not.toHaveBeenCalled();
      expect(mockDb.insert).not.toHaveBeenCalled();
    });
  });

  describe("onFinish — agent path", () => {
    it("upserts with agentId and per-call generation fields nulled", async () => {
      mockDb.returning.mockResolvedValueOnce([{ id: "chat-1" }]);

      const sink = new ChatSink({ orgId: "org-1", workspaceId: "ws-1" });
      await sink.onStart({ runId: "chat-1" });
      await sink.onResolved({ runId: "chat-1", plan: planWithAgent });
      await sink.onFinish({
        runId: "chat-1",
        status: "succeeded",
        messages: [{ role: "user", parts: [] } as any],
        stats: {},
      });

      expect(mockDb.update).toHaveBeenCalledTimes(1);
      const setArg = mockDb.set.mock.calls[0][0];
      expect(setArg.agentId).toBe("a1");
      expect(setArg.providerId).toBeNull();
      expect(setArg.modelId).toBeNull();
      expect(setArg.systemPrompt).toBeNull();
      expect(setArg.temperature).toBeNull();
      expect(setArg.topP).toBeNull();
      expect(setArg.seed).toBeNull();
      expect(setArg.presencePenalty).toBeNull();
      expect(setArg.frequencyPenalty).toBeNull();
      expect(mockDb.insert).not.toHaveBeenCalled();
    });

    it("falls back to insert when update affects zero rows", async () => {
      mockDb.returning.mockResolvedValueOnce([]);

      const sink = new ChatSink({ orgId: "org-1", workspaceId: "ws-1" });
      await sink.onStart({ runId: "chat-2" });
      await sink.onResolved({ runId: "chat-2", plan: planWithAgent });
      await sink.onFinish({
        runId: "chat-2",
        status: "succeeded",
        messages: [],
        stats: {},
      });

      expect(mockDb.update).toHaveBeenCalledTimes(1);
      expect(mockDb.insert).toHaveBeenCalledTimes(1);
      const insertedValues = mockDb.values.mock.calls[0][0];
      expect(insertedValues.id).toBe("chat-2");
      expect(insertedValues.workspaceId).toBe("ws-1");
      expect(insertedValues.title).toBe("Untitled");
      expect(insertedValues.agentId).toBe("a1");
    });
  });

  describe("onFinish — adhoc path", () => {
    it("persists provider/model and the resolved generation config", async () => {
      mockDb.returning.mockResolvedValueOnce([{ id: "chat-3" }]);

      const sink = new ChatSink({ orgId: "org-1", workspaceId: "ws-1" });
      await sink.onStart({ runId: "chat-3" });
      await sink.onResolved({ runId: "chat-3", plan: planAdhoc });
      await sink.onFinish({
        runId: "chat-3",
        status: "succeeded",
        messages: [],
        stats: {},
      });

      const setArg = mockDb.set.mock.calls[0][0];
      expect(setArg.agentId).toBeNull();
      expect(setArg.providerId).toBe("p1");
      expect(setArg.modelId).toBe("m1");
      expect(setArg.systemPrompt).toBe("raw prompt");
      expect(setArg.temperature).toBe(0.7);
      expect(setArg.topP).toBe(0.9);
      expect(setArg.topK).toBe(5);
      expect(setArg.seed).toBe(42);
      expect(setArg.presencePenalty).toBe(0.1);
      expect(setArg.frequencyPenalty).toBe(0.2);
    });
  });

  describe("onFinish — no plan", () => {
    it("skips the upsert if onResolved was never called", async () => {
      const sink = new ChatSink({ orgId: "org-1", workspaceId: "ws-1" });
      await sink.onFinish({
        runId: "chat-x",
        status: "failed",
        messages: [],
        stats: {},
      });
      expect(mockDb.update).not.toHaveBeenCalled();
      expect(mockDb.insert).not.toHaveBeenCalled();
    });
  });
});
