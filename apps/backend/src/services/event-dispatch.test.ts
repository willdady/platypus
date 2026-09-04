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
import { withCausation } from "../event-causation.ts";

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

/**
 * Dispatches two events of the same type back-to-back inside the debounce
 * window and reports how many trigger runs came out the other side: 1 when
 * the pair shared a debounce key, 2 when it keyed apart.
 */
async function runsForPair(
  trigger: ReturnType<typeof makeEventTrigger>,
  event: Parameters<typeof dispatchEvent>[2],
  first: unknown,
  second: unknown,
): Promise<number> {
  // Each dispatch runs its own webhook query (none) then trigger query.
  mockDb.where
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([trigger])
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([trigger]);

  dispatchEvent("org-1", "ws-1", event, first);
  await vi.advanceTimersByTimeAsync(0);
  dispatchEvent("org-1", "ws-1", event, second);
  await flushMicrotasks();

  return mockExecuteTrigger.mock.calls.length;
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

      dispatchEvent("org-1", "ws-1", "card.created", { cardId: "c1" });
      await flushMicrotasks();

      expect(mockDeliverWebhook).toHaveBeenCalledWith(
        "https://example.com/hook",
        expect.stringContaining("card.created"),
        "secret",
        expect.any(String),
        null,
      );

      // The delivered envelope carries both org and workspace coordinates.
      const body = JSON.parse(
        mockDeliverWebhook.mock.calls[0][1] as string,
      ) as Record<string, unknown>;
      expect(body).toMatchObject({
        event: "card.created",
        orgId: "org-1",
        workspaceId: "ws-1",
        data: { cardId: "c1" },
      });
    });

    it("should skip disabled webhooks", async () => {
      const webhook = makeWebhook({ enabled: false });
      mockDb.where.mockResolvedValueOnce([webhook]).mockResolvedValueOnce([]);

      dispatchEvent("org-1", "ws-1", "card.created", { cardId: "c1" });
      await flushMicrotasks();

      expect(mockDeliverWebhook).not.toHaveBeenCalled();
    });

    it("should skip webhooks not subscribed to the event", async () => {
      const webhook = makeWebhook({ events: ["card.deleted"] });
      mockDb.where.mockResolvedValueOnce([webhook]).mockResolvedValueOnce([]);

      dispatchEvent("org-1", "ws-1", "card.created", { cardId: "c1" });
      await flushMicrotasks();

      expect(mockDeliverWebhook).not.toHaveBeenCalled();
    });

    it("should execute matching event triggers", async () => {
      const trigger = makeEventTrigger();
      mockDb.where
        .mockResolvedValueOnce([]) // no webhooks
        .mockResolvedValueOnce([trigger]); // event triggers

      dispatchEvent("org-1", "ws-1", "card.created", { cardId: "c1" });
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

      dispatchEvent("org-1", "ws-1", "card.created", { cardId: "c1" });
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
      dispatchEvent("org-1", "ws-1", "card.created", {
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

      dispatchEvent("org-1", "ws-1", "card.created", {
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

      dispatchEvent("org-1", "ws-1", "card.created", {
        cardId: "c1",
        columnId: "col-2",
      });
      await flushMicrotasks();

      expect(mockExecuteTrigger).not.toHaveBeenCalled();
    });

    it("should filter triggers by changedFields when the filter set does not intersect", async () => {
      const trigger = makeEventTrigger({
        config: {
          events: ["card.updated"],
          filters: { changedFields: ["assignees"] },
        },
      });
      mockDb.where.mockResolvedValueOnce([]).mockResolvedValueOnce([trigger]);

      dispatchEvent("org-1", "ws-1", "card.updated", {
        id: "c1",
        changedFields: ["body"],
      });
      await flushMicrotasks();

      expect(mockExecuteTrigger).not.toHaveBeenCalled();
    });

    it("should execute the trigger when the changedFields filter intersects the event", async () => {
      const trigger = makeEventTrigger({
        config: {
          events: ["card.updated"],
          filters: { changedFields: ["assignees"] },
        },
      });
      mockDb.where.mockResolvedValueOnce([]).mockResolvedValueOnce([trigger]);

      dispatchEvent("org-1", "ws-1", "card.updated", {
        id: "c1",
        changedFields: ["assignees", "body"],
      });
      await flushMicrotasks();

      expect(mockExecuteTrigger).toHaveBeenCalled();
    });

    it("should ignore the changedFields filter for an event other than card.updated", async () => {
      const trigger = makeEventTrigger({
        config: {
          events: ["card.moved", "card.updated"],
          filters: { changedFields: ["assignees"] },
        },
      });
      mockDb.where.mockResolvedValueOnce([]).mockResolvedValueOnce([trigger]);

      // A move emits card.moved (no changedFields) then card.updated. Only
      // card.updated answers to the filter, so the move still fires.
      dispatchEvent("org-1", "ws-1", "card.moved", {
        id: "c1",
        previousColumnId: "col-1",
      });
      await flushMicrotasks();

      expect(mockExecuteTrigger).toHaveBeenCalled();
    });

    it("should compose the changedFields filter with the boardId filter", async () => {
      const trigger = makeEventTrigger({
        config: {
          events: ["card.updated"],
          filters: { boardId: "board-1", changedFields: ["assignees"] },
        },
      });
      mockDb.where.mockResolvedValueOnce([]).mockResolvedValueOnce([trigger]);

      dispatchEvent("org-1", "ws-1", "card.updated", {
        id: "c1",
        boardId: "board-2",
        changedFields: ["assignees"],
      });
      await flushMicrotasks();

      expect(mockExecuteTrigger).not.toHaveBeenCalled();
    });

    it("should fire card.moved for a column filter matching the destination column", async () => {
      const trigger = makeEventTrigger({
        config: {
          events: ["card.moved"],
          filters: { columnId: "col-dest" },
        },
      });
      mockDb.where.mockResolvedValueOnce([]).mockResolvedValueOnce([trigger]);

      dispatchEvent("org-1", "ws-1", "card.moved", {
        id: "c1",
        columnId: "col-dest",
        previousColumnId: "col-source",
      });
      await flushMicrotasks();

      expect(mockExecuteTrigger).toHaveBeenCalled();
    });

    it("should not fire card.moved for a column filter matching only the source column", async () => {
      const trigger = makeEventTrigger({
        config: {
          events: ["card.moved"],
          filters: { columnId: "col-source" },
        },
      });
      mockDb.where.mockResolvedValueOnce([]).mockResolvedValueOnce([trigger]);

      dispatchEvent("org-1", "ws-1", "card.moved", {
        id: "c1",
        columnId: "col-dest",
        previousColumnId: "col-source",
      });
      await flushMicrotasks();

      expect(mockExecuteTrigger).not.toHaveBeenCalled();
    });

    it("should skip a card.moved trigger when its own agent caused the event", async () => {
      const trigger = makeEventTrigger({
        agentId: "agent-1",
        config: { events: ["card.moved"], filters: undefined },
      });
      mockDb.where.mockResolvedValueOnce([]).mockResolvedValueOnce([trigger]);

      withCausation(["agent-1"], () =>
        dispatchEvent("org-1", "ws-1", "card.moved", {
          id: "c1",
          columnId: "col-dest",
          previousColumnId: "col-source",
        }),
      );
      await flushMicrotasks();

      expect(mockExecuteTrigger).not.toHaveBeenCalled();
    });

    it("should reach the debounce path for card.moved, coalescing rapid duplicates", async () => {
      const trigger = makeEventTrigger({
        config: { events: ["card.moved"], filters: undefined },
      });
      mockDb.where
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([trigger])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([trigger]);

      dispatchEvent("org-1", "ws-1", "card.moved", {
        id: "c1",
        columnId: "col-dest",
        previousColumnId: "col-source",
      });
      await vi.advanceTimersByTimeAsync(0);
      dispatchEvent("org-1", "ws-1", "card.moved", {
        id: "c1",
        columnId: "col-dest",
        previousColumnId: "col-source",
      });
      await flushMicrotasks();

      // Both calls key onto the same trigger+card debounce entry, so they
      // coalesce into a single execution — same as card.updated does.
      expect(mockExecuteTrigger).toHaveBeenCalledTimes(1);
    });

    it("should not coalesce card.deleted events for two different cards", async () => {
      // card.deleted carries its id as `cardId`, not `id`. Two unrelated cards
      // deleted inside the debounce window must key apart (#811).
      const runs = await runsForPair(
        makeEventTrigger({ config: { events: ["card.deleted"] } }),
        "card.deleted",
        { cardId: "c1", boardId: "board-1", columnId: "col-1" },
        { cardId: "c2", boardId: "board-1", columnId: "col-1" },
      );

      expect(runs).toBe(2);
    });

    it("should still coalesce repeated card.deleted events for the same card", async () => {
      const runs = await runsForPair(
        makeEventTrigger({ config: { events: ["card.deleted"] } }),
        "card.deleted",
        { cardId: "c1", boardId: "board-1", columnId: "col-1" },
        { cardId: "c1", boardId: "board-1", columnId: "col-1" },
      );

      expect(runs).toBe(1);
    });

    it("should not coalesce notification.dismissed events for two different notifications", async () => {
      const runs = await runsForPair(
        makeEventTrigger({ config: { events: ["notification.dismissed"] } }),
        "notification.dismissed",
        { notificationId: "n-1" },
        { notificationId: "n-2" },
      );

      expect(runs).toBe(2);
    });

    it("should not coalesce single notification.read events for two different notifications", async () => {
      const runs = await runsForPair(
        makeEventTrigger({ config: { events: ["notification.read"] } }),
        "notification.read",
        { notificationId: "n-1", userId: "user-1" },
        { notificationId: "n-2", userId: "user-1" },
      );

      expect(runs).toBe(2);
    });

    it("should coalesce bulk notification.read events, which name no single entity", async () => {
      // A bulk mark-all-read is legitimately a multi-entity event, so it keeps
      // sharing the per-trigger fallback bucket.
      const runs = await runsForPair(
        makeEventTrigger({ config: { events: ["notification.read"] } }),
        "notification.read",
        { notificationIds: ["n-1", "n-2"], userId: "user-1", bulk: true },
        { notificationIds: ["n-3"], userId: "user-1", bulk: true },
      );

      expect(runs).toBe(1);
    });

    it("should prefer a top-level id over an alternate key when both are present", async () => {
      // Row-spreading events carry `id`; a stray `cardId` naming a different
      // entity must not split the bucket for one and the same card.
      const runs = await runsForPair(
        makeEventTrigger({ config: { events: ["card.updated"] } }),
        "card.updated",
        { id: "c1", cardId: "other-1" },
        { id: "c1", cardId: "other-2" },
      );

      expect(runs).toBe(1);
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

      dispatchEvent("org-1", "ws-1", "card.created", { cardId: "c1" });
      await flushMicrotasks();

      expect(mockDeliverWebhook).toHaveBeenCalledTimes(2);
      expect(mockExecuteTrigger).toHaveBeenCalledTimes(2);
    });

    it("should not throw when trigger execution fails", async () => {
      const trigger = makeEventTrigger();
      mockDb.where.mockResolvedValueOnce([]).mockResolvedValueOnce([trigger]);

      mockExecuteTrigger.mockRejectedValue(new Error("Execution failed"));

      // Should not throw — errors are caught internally
      dispatchEvent("org-1", "ws-1", "card.created", { cardId: "c1" });
      await flushMicrotasks();
    });

    it("should skip a trigger when its own agent caused the event", async () => {
      const trigger = makeEventTrigger({ agentId: "agent-1" });
      mockDb.where.mockResolvedValueOnce([]).mockResolvedValueOnce([trigger]);

      withCausation(["agent-1"], () =>
        dispatchEvent("org-1", "ws-1", "card.updated", { id: "c1" }),
      );
      await flushMicrotasks();

      expect(mockExecuteTrigger).not.toHaveBeenCalled();
    });

    it("should skip a trigger when a sub-agent of its own agent caused the event (depth 1)", async () => {
      const trigger = makeEventTrigger({ agentId: "agent-1" });
      mockDb.where.mockResolvedValueOnce([]).mockResolvedValueOnce([trigger]);

      // The run's chain is the parent Agent plus the delegate beneath it.
      withCausation(["agent-1", "sub-1"], () =>
        dispatchEvent("org-1", "ws-1", "card.updated", { id: "c1" }),
      );
      await flushMicrotasks();

      expect(mockExecuteTrigger).not.toHaveBeenCalled();
    });

    it("should skip a trigger when a sub-agent of its own agent caused the event (depth 2+)", async () => {
      const trigger = makeEventTrigger({ agentId: "agent-1" });
      mockDb.where.mockResolvedValueOnce([]).mockResolvedValueOnce([trigger]);

      withCausation(["agent-1", "sub-1", "sub-2"], () =>
        dispatchEvent("org-1", "ws-1", "card.updated", { id: "c1" }),
      );
      await flushMicrotasks();

      expect(mockExecuteTrigger).not.toHaveBeenCalled();
    });

    it("should fire on a human event even when the trigger's agent previously touched the card", async () => {
      const trigger = makeEventTrigger({ agentId: "agent-1" });
      mockDb.where.mockResolvedValueOnce([]).mockResolvedValueOnce([trigger]);

      // Human write path supplies no actor, even though the card row still
      // carries a stale lastEditedByAgentId from a prior agent edit.
      dispatchEvent("org-1", "ws-1", "card.updated", {
        id: "c1",
        lastEditedByAgentId: "agent-1",
      });
      await flushMicrotasks();

      expect(mockExecuteTrigger).toHaveBeenCalled();
    });

    it("should fire when a different agent caused the event", async () => {
      const trigger = makeEventTrigger({ agentId: "agent-1" });
      mockDb.where.mockResolvedValueOnce([]).mockResolvedValueOnce([trigger]);

      // A genuinely unrelated Agent, with no delegation relationship to the
      // trigger's Agent, still fires it.
      withCausation(["agent-2"], () =>
        dispatchEvent("org-1", "ws-1", "card.updated", { id: "c1" }),
      );
      await flushMicrotasks();

      expect(mockExecuteTrigger).toHaveBeenCalled();
    });

    it("should not apply the self-actor guard to triggers without an agentId", async () => {
      const trigger = makeEventTrigger({ agentId: null });
      mockDb.where.mockResolvedValueOnce([]).mockResolvedValueOnce([trigger]);

      withCausation(["agent-1"], () =>
        dispatchEvent("org-1", "ws-1", "card.updated", { id: "c1" }),
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

      dispatchEvent("org-1", "ws-1", "card.created", { cardId: "c1" });
      await flushMicrotasks();

      expect(mockDeliverWebhook).toHaveBeenCalledTimes(1);
      expect(mockExecuteTrigger).toHaveBeenCalledTimes(1);
    });

    it("should not fire a trigger on its own agent's notification writes", async () => {
      const trigger = makeEventTrigger({
        agentId: "agent-1",
        config: { events: ["notification.created"], filters: undefined },
      });

      for (const event of [
        "notification.created",
        "notification.updated",
        "notification.dismissed",
      ] as const) {
        mockDb.where.mockClear();
        vi.mocked(mockExecuteTrigger).mockClear();
        mockDb.where.mockResolvedValueOnce([]).mockResolvedValueOnce([trigger]);

        withCausation(["agent-1"], () =>
          dispatchEvent("org-1", "ws-1", event, { id: "n-1" }),
        );
        await flushMicrotasks();

        expect(mockExecuteTrigger).not.toHaveBeenCalled();
      }
    });

    it("should not fire a trigger on its own agent's notification writes under delegation", async () => {
      const trigger = makeEventTrigger({
        agentId: "agent-1",
        config: { events: ["notification.created"], filters: undefined },
      });
      mockDb.where.mockResolvedValueOnce([]).mockResolvedValueOnce([trigger]);

      withCausation(["agent-1", "sub-1"], () =>
        dispatchEvent("org-1", "ws-1", "notification.created", { id: "n-1" }),
      );
      await flushMicrotasks();

      expect(mockExecuteTrigger).not.toHaveBeenCalled();
    });

    it("suppresses only the trigger whose agent caused the event, running the rest", async () => {
      const suppressed = makeEventTrigger({
        id: "trigger-1",
        agentId: "agent-1",
      });
      const unrelated = makeEventTrigger({
        id: "trigger-2",
        agentId: "agent-9",
      });
      const webhook = makeWebhook();
      mockDb.where
        .mockResolvedValueOnce([webhook])
        .mockResolvedValueOnce([suppressed, unrelated]);

      withCausation(["agent-1"], () =>
        dispatchEvent("org-1", "ws-1", "card.created", { cardId: "c1" }),
      );
      await flushMicrotasks();

      // Every subscribed Webhook still receives the event even though one of
      // the triggers was suppressed.
      expect(mockDeliverWebhook).toHaveBeenCalledTimes(1);
      // The suppressed trigger's run never starts, but the unrelated one does.
      expect(mockExecuteTrigger).toHaveBeenCalledTimes(1);
      expect(mockExecuteTrigger).toHaveBeenCalledWith(unrelated, {
        eventType: "card.created",
        eventData: { cardId: "c1" },
      });
    });
  });
});
