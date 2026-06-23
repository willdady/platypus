import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mockDb, resetMockDb } from "../test-utils.ts";
import { clearPendingTriggers } from "./event-trigger-debounce.ts";

const { mockDeliverWebhook, mockExecuteTrigger, mockUpdateTriggerAfterRun } =
  vi.hoisted(() => ({
    mockDeliverWebhook: vi.fn(),
    mockExecuteTrigger: vi.fn(),
    mockUpdateTriggerAfterRun: vi.fn(),
  }));

vi.mock("./webhook-delivery.ts", () => ({
  deliverWebhook: mockDeliverWebhook,
}));

vi.mock("./trigger-execution.ts", () => ({
  executeTrigger: mockExecuteTrigger,
  updateTriggerAfterRun: mockUpdateTriggerAfterRun,
}));

vi.mock("../logger.ts", () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

import { dispatchEvent } from "./event-dispatch.ts";

const makeWebhook = (overrides: Record<string, unknown> = {}) => ({
  id: "wh-1",
  workspaceId: "ws-1",
  url: "https://example.com/hook",
  enabled: true,
  events: ["card.created", "card.updated"],
  signingSecret: "secret",
  headers: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

const makeEventTrigger = (overrides: Record<string, unknown> = {}) => ({
  id: "trigger-1",
  workspaceId: "ws-1",
  agentId: "agent-1",
  type: "event",
  name: "Test Event Trigger",
  instruction: "Handle the event",
  enabled: true,
  maxRunsToKeep: 10,
  search: false,
  config: {
    events: ["card.created", "card.updated"],
    filters: undefined,
  },
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

/**
 * dispatchEvent is fire-and-forget. We flush microtasks to let
 * the internal async IIFE settle before asserting.
 * Also advances past the 5s debounce window for event triggers.
 */
async function flushMicrotasks() {
  // Multiple rounds to allow nested void async IIFEs to resolve
  for (let i = 0; i < 10; i++) {
    await vi.advanceTimersByTimeAsync(0);
  }
  // Advance past the 5s debounce window for event triggers
  await vi.advanceTimersByTimeAsync(5_000);
  // Flush again so the debounced callback's async work settles
  for (let i = 0; i < 10; i++) {
    await vi.advanceTimersByTimeAsync(0);
  }
}

describe("event-dispatch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetMockDb();
    vi.clearAllMocks();
    mockExecuteTrigger.mockResolvedValue("chat-1");
    mockUpdateTriggerAfterRun.mockResolvedValue(undefined);
  });

  afterEach(() => {
    clearPendingTriggers();
    vi.useRealTimers();
  });

  describe("dispatchEvent", () => {
    it("should deliver webhooks for matching events", async () => {
      const webhook = makeWebhook();
      mockDb.where
        .mockResolvedValueOnce([webhook]) // webhooks query
        .mockResolvedValueOnce([]); // event triggers query

      dispatchEvent("ws-1", "card.created", { cardId: "c1" });
      await flushMicrotasks();

      expect(mockDeliverWebhook).toHaveBeenCalledWith(
        "https://example.com/hook",
        expect.stringContaining("card.created"),
        "secret",
        expect.any(String),
        null,
      );
    });

    it("should skip disabled webhooks", async () => {
      const webhook = makeWebhook({ enabled: false });
      mockDb.where.mockResolvedValueOnce([webhook]).mockResolvedValueOnce([]);

      dispatchEvent("ws-1", "card.created", { cardId: "c1" });
      await flushMicrotasks();

      expect(mockDeliverWebhook).not.toHaveBeenCalled();
    });

    it("should skip webhooks not subscribed to the event", async () => {
      const webhook = makeWebhook({ events: ["card.deleted"] });
      mockDb.where.mockResolvedValueOnce([webhook]).mockResolvedValueOnce([]);

      dispatchEvent("ws-1", "card.created", { cardId: "c1" });
      await flushMicrotasks();

      expect(mockDeliverWebhook).not.toHaveBeenCalled();
    });

    it("should execute matching event triggers", async () => {
      const trigger = makeEventTrigger();
      mockDb.where
        .mockResolvedValueOnce([]) // no webhooks
        .mockResolvedValueOnce([trigger]); // event triggers

      dispatchEvent("ws-1", "card.created", { cardId: "c1" });
      await flushMicrotasks();

      expect(mockExecuteTrigger).toHaveBeenCalledWith(trigger, {
        eventType: "card.created",
        eventData: { cardId: "c1" },
      });
      expect(mockUpdateTriggerAfterRun).toHaveBeenCalledWith(
        "trigger-1",
        trigger,
      );
    });

    it("should skip triggers not subscribed to the event", async () => {
      const trigger = makeEventTrigger({
        config: { events: ["card.deleted"] },
      });
      mockDb.where.mockResolvedValueOnce([]).mockResolvedValueOnce([trigger]);

      dispatchEvent("ws-1", "card.created", { cardId: "c1" });
      await flushMicrotasks();

      expect(mockExecuteTrigger).not.toHaveBeenCalled();
    });

    it("should filter triggers by boardId when filter is set", async () => {
      const trigger = makeEventTrigger({
        config: {
          events: ["card.created"],
          filters: { boardId: "board-1" },
        },
      });
      mockDb.where.mockResolvedValueOnce([]).mockResolvedValueOnce([trigger]);

      // Event data has a different boardId
      dispatchEvent("ws-1", "card.created", {
        cardId: "c1",
        boardId: "board-2",
      });
      await flushMicrotasks();

      expect(mockExecuteTrigger).not.toHaveBeenCalled();
    });

    it("should execute trigger when boardId filter matches", async () => {
      const trigger = makeEventTrigger({
        config: {
          events: ["card.created"],
          filters: { boardId: "board-1" },
        },
      });
      mockDb.where.mockResolvedValueOnce([]).mockResolvedValueOnce([trigger]);

      dispatchEvent("ws-1", "card.created", {
        cardId: "c1",
        boardId: "board-1",
      });
      await flushMicrotasks();

      expect(mockExecuteTrigger).toHaveBeenCalled();
    });

    it("should filter triggers by columnId when filter is set", async () => {
      const trigger = makeEventTrigger({
        config: {
          events: ["card.created"],
          filters: { columnId: "col-1" },
        },
      });
      mockDb.where.mockResolvedValueOnce([]).mockResolvedValueOnce([trigger]);

      dispatchEvent("ws-1", "card.created", {
        cardId: "c1",
        columnId: "col-2",
      });
      await flushMicrotasks();

      expect(mockExecuteTrigger).not.toHaveBeenCalled();
    });

    it("should handle multiple webhooks and triggers", async () => {
      const webhook1 = makeWebhook({ id: "wh-1" });
      const webhook2 = makeWebhook({
        id: "wh-2",
        url: "https://other.com/hook",
      });
      const trigger1 = makeEventTrigger({ id: "trigger-1" });
      const trigger2 = makeEventTrigger({ id: "trigger-2" });

      mockDb.where
        .mockResolvedValueOnce([webhook1, webhook2])
        .mockResolvedValueOnce([trigger1, trigger2]);

      dispatchEvent("ws-1", "card.created", { cardId: "c1" });
      await flushMicrotasks();

      expect(mockDeliverWebhook).toHaveBeenCalledTimes(2);
      expect(mockExecuteTrigger).toHaveBeenCalledTimes(2);
    });

    it("should not throw when trigger execution fails", async () => {
      const trigger = makeEventTrigger();
      mockDb.where.mockResolvedValueOnce([]).mockResolvedValueOnce([trigger]);

      mockExecuteTrigger.mockRejectedValue(new Error("Execution failed"));

      // Should not throw — errors are caught internally
      dispatchEvent("ws-1", "card.created", { cardId: "c1" });
      await flushMicrotasks();
    });

    it("should skip a trigger when its own agent caused the event", async () => {
      const trigger = makeEventTrigger({ agentId: "agent-1" });
      mockDb.where.mockResolvedValueOnce([]).mockResolvedValueOnce([trigger]);

      dispatchEvent(
        "ws-1",
        "card.updated",
        { id: "c1" },
        { actorAgentId: "agent-1" },
      );
      await flushMicrotasks();

      expect(mockExecuteTrigger).not.toHaveBeenCalled();
    });

    it("should fire on a human event even when the trigger's agent previously touched the card", async () => {
      const trigger = makeEventTrigger({ agentId: "agent-1" });
      mockDb.where.mockResolvedValueOnce([]).mockResolvedValueOnce([trigger]);

      // Human write path supplies no actor, even though the card row still
      // carries a stale lastEditedByAgentId from a prior agent edit.
      dispatchEvent("ws-1", "card.updated", {
        id: "c1",
        lastEditedByAgentId: "agent-1",
      });
      await flushMicrotasks();

      expect(mockExecuteTrigger).toHaveBeenCalled();
    });

    it("should fire when a different agent caused the event", async () => {
      const trigger = makeEventTrigger({ agentId: "agent-1" });
      mockDb.where.mockResolvedValueOnce([]).mockResolvedValueOnce([trigger]);

      dispatchEvent(
        "ws-1",
        "card.updated",
        { id: "c1" },
        { actorAgentId: "agent-2" },
      );
      await flushMicrotasks();

      expect(mockExecuteTrigger).toHaveBeenCalled();
    });

    it("should not apply the self-actor guard to triggers without an agentId", async () => {
      const trigger = makeEventTrigger({ agentId: null });
      mockDb.where.mockResolvedValueOnce([]).mockResolvedValueOnce([trigger]);

      dispatchEvent(
        "ws-1",
        "card.updated",
        { id: "c1" },
        { actorAgentId: "agent-1" },
      );
      await flushMicrotasks();

      expect(mockExecuteTrigger).toHaveBeenCalled();
    });

    it("should dispatch to both webhooks and triggers for the same event", async () => {
      const webhook = makeWebhook();
      const trigger = makeEventTrigger();
      mockDb.where
        .mockResolvedValueOnce([webhook])
        .mockResolvedValueOnce([trigger]);

      dispatchEvent("ws-1", "card.created", { cardId: "c1" });
      await flushMicrotasks();

      expect(mockDeliverWebhook).toHaveBeenCalledTimes(1);
      expect(mockExecuteTrigger).toHaveBeenCalledTimes(1);
    });
  });
});
