import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { WebhookEventData, WebhookEventPayload } from "@platypus/schemas";
import {
  cardEvent,
  mockDb,
  notificationEvent,
  resetMockDb,
} from "../test-utils.ts";
import { clearPendingTriggers } from "./event-trigger-debounce.ts";

const { mockDeliverWebhook, mockFireTrigger } = vi.hoisted(() => ({
  mockDeliverWebhook: vi.fn(),
  mockFireTrigger: vi.fn(),
}));

vi.mock("./webhook-delivery.ts", () => ({
  deliverWebhook: mockDeliverWebhook,
}));

// Dispatch decides which Trigger fires and when; what firing does — the
// breaker, the run, its bookkeeping — is `trigger-firing.test.ts`'s subject.
vi.mock("./trigger-firing.ts", () => ({
  fireTrigger: mockFireTrigger,
}));

import { mockLogger } from "../test-setup.ts";

import { dispatchEvent } from "./event-dispatch.ts";
import { withCausation, withOriginatingTrigger } from "../event-causation.ts";

/** The dispatch-decision lines the logger recorded, newest last. */
const decisionLines = (): Record<string, unknown>[] =>
  mockLogger.info.mock.calls
    .filter((call) => call[1] === "Event trigger dispatch decision")
    .map((call) => call[0] as Record<string, unknown>);

/** A `card.deleted` naming one card — the ids it carries and nothing else. */
const deletedEvent = (cardId: string): WebhookEventPayload => ({
  event: "card.deleted",
  data: { cardId, boardId: "board-1", columnId: "col-1" },
});

/** A `notification.read` in either of its two declared shapes. */
const readEvent = (
  data: WebhookEventData<"notification.read">,
): WebhookEventPayload => ({ event: "notification.read", data });

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
  first: WebhookEventPayload,
  second: WebhookEventPayload,
): Promise<number> {
  // Each dispatch runs its own webhook query (none) then trigger query.
  mockDb.where
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([trigger])
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([trigger]);

  dispatchEvent("org-1", "ws-1", first);
  await vi.advanceTimersByTimeAsync(0);
  dispatchEvent("org-1", "ws-1", second);
  await flushMicrotasks();

  return mockFireTrigger.mock.calls.length;
}

describe("event-dispatch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetMockDb();
    vi.clearAllMocks();
    mockFireTrigger.mockResolvedValue("ran");
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

      const created = cardEvent("card.created", { id: "c1" });
      dispatchEvent("org-1", "ws-1", created);
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
        data: JSON.parse(JSON.stringify(created.data)) as unknown,
      });
    });

    it("should skip disabled webhooks", async () => {
      const webhook = makeWebhook({ enabled: false });
      mockDb.where.mockResolvedValueOnce([webhook]).mockResolvedValueOnce([]);

      dispatchEvent("org-1", "ws-1", cardEvent("card.created", { id: "c1" }));
      await flushMicrotasks();

      expect(mockDeliverWebhook).not.toHaveBeenCalled();
    });

    it("should skip webhooks not subscribed to the event", async () => {
      const webhook = makeWebhook({ events: ["card.deleted"] });
      mockDb.where.mockResolvedValueOnce([webhook]).mockResolvedValueOnce([]);

      dispatchEvent("org-1", "ws-1", cardEvent("card.created", { id: "c1" }));
      await flushMicrotasks();

      expect(mockDeliverWebhook).not.toHaveBeenCalled();
    });

    it("should execute matching event triggers", async () => {
      const trigger = makeEventTrigger();
      mockDb.where
        .mockResolvedValueOnce([]) // no webhooks
        .mockResolvedValueOnce([trigger]); // event triggers

      const created = cardEvent("card.created", { id: "c1" });
      dispatchEvent("org-1", "ws-1", created);
      await flushMicrotasks();

      expect(mockFireTrigger).toHaveBeenCalledWith(trigger, {
        kind: "event",
        payload: created,
        entityId: "c1",
      });
    });

    it("should skip triggers not subscribed to the event", async () => {
      const trigger = makeEventTrigger({
        config: { events: ["card.deleted"] },
      });
      mockDb.where.mockResolvedValueOnce([]).mockResolvedValueOnce([trigger]);

      dispatchEvent("org-1", "ws-1", cardEvent("card.created", { id: "c1" }));
      await flushMicrotasks();

      expect(mockFireTrigger).not.toHaveBeenCalled();
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
      dispatchEvent(
        "org-1",
        "ws-1",
        cardEvent("card.created", { id: "c1", boardId: "board-2" }),
      );
      await flushMicrotasks();

      expect(mockFireTrigger).not.toHaveBeenCalled();
    });

    it("should execute trigger when boardId filter matches", async () => {
      const trigger = makeEventTrigger({
        config: {
          events: ["card.created"],
          filters: { boardId: "board-1" },
        },
      });
      mockDb.where.mockResolvedValueOnce([]).mockResolvedValueOnce([trigger]);

      dispatchEvent(
        "org-1",
        "ws-1",
        cardEvent("card.created", { id: "c1", boardId: "board-1" }),
      );
      await flushMicrotasks();

      expect(mockFireTrigger).toHaveBeenCalled();
    });

    it("should filter triggers by columnId when filter is set", async () => {
      const trigger = makeEventTrigger({
        config: {
          events: ["card.created"],
          filters: { columnId: "col-1" },
        },
      });
      mockDb.where.mockResolvedValueOnce([]).mockResolvedValueOnce([trigger]);

      dispatchEvent(
        "org-1",
        "ws-1",
        cardEvent("card.created", { id: "c1", columnId: "col-2" }),
      );
      await flushMicrotasks();

      expect(mockFireTrigger).not.toHaveBeenCalled();
    });

    it("should filter triggers by changedFields when the filter set does not intersect", async () => {
      const trigger = makeEventTrigger({
        config: {
          events: ["card.updated"],
          filters: { changedFields: ["assignees"] },
        },
      });
      mockDb.where.mockResolvedValueOnce([]).mockResolvedValueOnce([trigger]);

      dispatchEvent(
        "org-1",
        "ws-1",
        cardEvent("card.updated", { id: "c1", changedFields: ["body"] }),
      );
      await flushMicrotasks();

      expect(mockFireTrigger).not.toHaveBeenCalled();
    });

    it("should execute the trigger when the changedFields filter intersects the event", async () => {
      const trigger = makeEventTrigger({
        config: {
          events: ["card.updated"],
          filters: { changedFields: ["assignees"] },
        },
      });
      mockDb.where.mockResolvedValueOnce([]).mockResolvedValueOnce([trigger]);

      dispatchEvent(
        "org-1",
        "ws-1",
        cardEvent("card.updated", {
          id: "c1",
          changedFields: ["assignees", "body"],
        }),
      );
      await flushMicrotasks();

      expect(mockFireTrigger).toHaveBeenCalled();
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
      dispatchEvent(
        "org-1",
        "ws-1",
        cardEvent("card.moved", { id: "c1", previousColumnId: "col-1" }),
      );
      await flushMicrotasks();

      expect(mockFireTrigger).toHaveBeenCalled();
    });

    it("should compose the changedFields filter with the boardId filter", async () => {
      const trigger = makeEventTrigger({
        config: {
          events: ["card.updated"],
          filters: { boardId: "board-1", changedFields: ["assignees"] },
        },
      });
      mockDb.where.mockResolvedValueOnce([]).mockResolvedValueOnce([trigger]);

      dispatchEvent(
        "org-1",
        "ws-1",
        cardEvent("card.updated", {
          id: "c1",
          boardId: "board-2",
          changedFields: ["assignees"],
        }),
      );
      await flushMicrotasks();

      expect(mockFireTrigger).not.toHaveBeenCalled();
    });

    it("should fire card.moved for a column filter matching the destination column", async () => {
      const trigger = makeEventTrigger({
        config: {
          events: ["card.moved"],
          filters: { columnId: "col-dest" },
        },
      });
      mockDb.where.mockResolvedValueOnce([]).mockResolvedValueOnce([trigger]);

      dispatchEvent(
        "org-1",
        "ws-1",
        cardEvent("card.moved", {
          id: "c1",
          columnId: "col-dest",
          previousColumnId: "col-source",
        }),
      );
      await flushMicrotasks();

      expect(mockFireTrigger).toHaveBeenCalled();
    });

    it("should not fire card.moved for a column filter matching only the source column", async () => {
      const trigger = makeEventTrigger({
        config: {
          events: ["card.moved"],
          filters: { columnId: "col-source" },
        },
      });
      mockDb.where.mockResolvedValueOnce([]).mockResolvedValueOnce([trigger]);

      dispatchEvent(
        "org-1",
        "ws-1",
        cardEvent("card.moved", {
          id: "c1",
          columnId: "col-dest",
          previousColumnId: "col-source",
        }),
      );
      await flushMicrotasks();

      expect(mockFireTrigger).not.toHaveBeenCalled();
    });

    it("should skip a card.moved trigger when its own agent caused the event", async () => {
      const trigger = makeEventTrigger({
        agentId: "agent-1",
        config: { events: ["card.moved"], filters: undefined },
      });
      mockDb.where.mockResolvedValueOnce([]).mockResolvedValueOnce([trigger]);

      withCausation(["agent-1"], () =>
        dispatchEvent(
          "org-1",
          "ws-1",
          cardEvent("card.moved", {
            id: "c1",
            columnId: "col-dest",
            previousColumnId: "col-source",
          }),
        ),
      );
      await flushMicrotasks();

      expect(mockFireTrigger).not.toHaveBeenCalled();
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

      dispatchEvent(
        "org-1",
        "ws-1",
        cardEvent("card.moved", {
          id: "c1",
          columnId: "col-dest",
          previousColumnId: "col-source",
        }),
      );
      await vi.advanceTimersByTimeAsync(0);
      dispatchEvent(
        "org-1",
        "ws-1",
        cardEvent("card.moved", {
          id: "c1",
          columnId: "col-dest",
          previousColumnId: "col-source",
        }),
      );
      await flushMicrotasks();

      // Both calls key onto the same trigger+card debounce entry, so they
      // coalesce into a single execution — same as card.updated does.
      expect(mockFireTrigger).toHaveBeenCalledTimes(1);
    });

    it("should not coalesce card.deleted events for two different cards", async () => {
      // card.deleted names its card as `cardId`, not `id`. Two unrelated cards
      // deleted inside the debounce window must key apart (#811).
      const runs = await runsForPair(
        makeEventTrigger({ config: { events: ["card.deleted"] } }),
        deletedEvent("c1"),
        deletedEvent("c2"),
      );

      expect(runs).toBe(2);
    });

    it("should still coalesce repeated card.deleted events for the same card", async () => {
      const runs = await runsForPair(
        makeEventTrigger({ config: { events: ["card.deleted"] } }),
        deletedEvent("c1"),
        deletedEvent("c1"),
      );

      expect(runs).toBe(1);
    });

    it("should not coalesce notification.dismissed events for two different notifications", async () => {
      const runs = await runsForPair(
        makeEventTrigger({ config: { events: ["notification.dismissed"] } }),
        { event: "notification.dismissed", data: { notificationId: "n-1" } },
        { event: "notification.dismissed", data: { notificationId: "n-2" } },
      );

      expect(runs).toBe(2);
    });

    it("should not coalesce single notification.read events for two different notifications", async () => {
      const runs = await runsForPair(
        makeEventTrigger({ config: { events: ["notification.read"] } }),
        readEvent({ notificationId: "n-1", userId: "user-1" }),
        readEvent({ notificationId: "n-2", userId: "user-1" }),
      );

      expect(runs).toBe(2);
    });

    it("should coalesce bulk notification.read events, which name no single entity", async () => {
      // A bulk mark-all-read is legitimately a multi-entity event, so it keeps
      // sharing the per-trigger fallback bucket.
      const runs = await runsForPair(
        makeEventTrigger({ config: { events: ["notification.read"] } }),
        readEvent({
          notificationIds: ["n-1", "n-2"],
          userId: "user-1",
          bulk: true,
        }),
        readEvent({ notificationIds: ["n-3"], userId: "user-1", bulk: true }),
      );

      expect(runs).toBe(1);
    });

    it("should coalesce two edits of the same card", async () => {
      const runs = await runsForPair(
        makeEventTrigger({ config: { events: ["card.updated"] } }),
        cardEvent("card.updated", { id: "c1", title: "first" }),
        cardEvent("card.updated", { id: "c1", title: "second" }),
      );

      expect(runs).toBe(1);
    });

    describe("what a firing is handed", () => {
      it("names the event's single entity, which the run-rate breaker counts by", async () => {
        const trigger = makeEventTrigger({
          config: { events: ["card.deleted"] },
        });
        mockDb.where.mockResolvedValueOnce([]).mockResolvedValueOnce([trigger]);

        const deleted = deletedEvent("c1");
        dispatchEvent("org-1", "ws-1", deleted);
        await flushMicrotasks();

        // Keyed by the event-specific id (`cardId`), not a shared bucket.
        expect(mockFireTrigger).toHaveBeenCalledWith(trigger, {
          kind: "event",
          payload: deleted,
          entityId: "c1",
        });
      });

      it("names no entity for an event that names a set", async () => {
        // A bulk mark-all-read names a set, so counting its firings would trip
        // the breaker after N unrelated Notifications.
        const trigger = makeEventTrigger({
          config: { events: ["notification.read"] },
        });
        mockDb.where.mockResolvedValueOnce([]).mockResolvedValueOnce([trigger]);

        const bulk = readEvent({
          notificationIds: ["n-1", "n-2"],
          userId: "user-1",
          bulk: true,
        });
        dispatchEvent("org-1", "ws-1", bulk);
        await flushMicrotasks();

        expect(mockFireTrigger).toHaveBeenCalledWith(trigger, {
          kind: "event",
          payload: bulk,
          entityId: undefined,
        });
      });

      it("fires only once the debounce window closes", async () => {
        const trigger = makeEventTrigger();
        mockDb.where.mockResolvedValueOnce([]).mockResolvedValueOnce([trigger]);

        dispatchEvent("org-1", "ws-1", cardEvent("card.created", { id: "c1" }));
        await vi.advanceTimersByTimeAsync(1_000);

        // Still inside the window: nothing has been decided yet, so a burst
        // folded into it reaches the breaker as one firing.
        expect(mockFireTrigger).not.toHaveBeenCalled();

        await flushMicrotasks();

        expect(mockFireTrigger).toHaveBeenCalledTimes(1);
      });

      it("records a firing the breaker dropped as suppressed", async () => {
        const trigger = makeEventTrigger({ id: "trigger-1" });
        mockDb.where.mockResolvedValueOnce([]).mockResolvedValueOnce([trigger]);
        mockFireTrigger.mockResolvedValue("suppressed");

        dispatchEvent("org-1", "ws-1", cardEvent("card.updated", { id: "c1" }));
        await flushMicrotasks();

        expect(decisionLines().map((line) => line.decision)).toEqual([
          "fired",
          "suppressed",
        ]);
      });
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

      dispatchEvent("org-1", "ws-1", cardEvent("card.created", { id: "c1" }));
      await flushMicrotasks();

      expect(mockDeliverWebhook).toHaveBeenCalledTimes(2);
      expect(mockFireTrigger).toHaveBeenCalledTimes(2);
    });

    it("skips a malformed trigger row without abandoning the others", async () => {
      const malformed = makeEventTrigger({ id: "trigger-bad", config: {} });
      const good = makeEventTrigger({ id: "trigger-good" });
      mockDb.where
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([malformed, good]);

      dispatchEvent("org-1", "ws-1", cardEvent("card.created", { id: "c1" }));
      await flushMicrotasks();

      expect(mockFireTrigger).toHaveBeenCalledTimes(1);
      expect(mockFireTrigger).toHaveBeenCalledWith(good, expect.anything());
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ triggerId: "trigger-bad" }),
        "Skipped a malformed event trigger",
      );
    });

    describe("dispatch decisions are logged", () => {
      it("records a fired dispatch with the causal chain and the trigger's agent", async () => {
        const trigger = makeEventTrigger({
          id: "trigger-1",
          agentId: "agent-2",
        });
        mockDb.where.mockResolvedValueOnce([]).mockResolvedValueOnce([trigger]);

        withCausation(["agent-1"], () =>
          dispatchEvent(
            "org-1",
            "ws-1",
            cardEvent("card.updated", { id: "c1" }),
          ),
        );
        await flushMicrotasks();

        expect(decisionLines()).toEqual([
          {
            event: "card.updated",
            workspaceId: "ws-1",
            triggerId: "trigger-1",
            triggerAgentId: "agent-2",
            causingAgents: ["agent-1"],
            originatingTriggerId: undefined,
            decision: "fired",
          },
        ]);
      });

      it("records the self-actor guard's decision, which is otherwise indistinguishable from no match", async () => {
        const trigger = makeEventTrigger({
          id: "trigger-1",
          agentId: "agent-1",
        });
        mockDb.where.mockResolvedValueOnce([]).mockResolvedValueOnce([trigger]);

        withCausation(["agent-1", "sub-1"], () =>
          dispatchEvent(
            "org-1",
            "ws-1",
            cardEvent("card.updated", { id: "c1" }),
          ),
        );
        await flushMicrotasks();

        expect(mockFireTrigger).not.toHaveBeenCalled();
        expect(decisionLines()).toEqual([
          {
            event: "card.updated",
            workspaceId: "ws-1",
            triggerId: "trigger-1",
            triggerAgentId: "agent-1",
            causingAgents: ["agent-1", "sub-1"],
            originatingTriggerId: undefined,
            decision: "skipped_self_actor",
          },
        ]);
      });

      it("records a second event of the same window as debounced", async () => {
        const trigger = makeEventTrigger({ id: "trigger-1" });
        mockDb.where
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([trigger])
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([trigger]);

        dispatchEvent("org-1", "ws-1", cardEvent("card.updated", { id: "c1" }));
        await vi.advanceTimersByTimeAsync(0);
        dispatchEvent("org-1", "ws-1", cardEvent("card.updated", { id: "c1" }));
        await flushMicrotasks();

        expect(mockFireTrigger).toHaveBeenCalledTimes(1);
        expect(decisionLines().map((line) => line.decision)).toEqual([
          "fired",
          "debounced",
        ]);
      });

      it("names the Trigger whose run caused the event", async () => {
        const trigger = makeEventTrigger({
          id: "trigger-2",
          agentId: "agent-2",
        });
        mockDb.where.mockResolvedValueOnce([]).mockResolvedValueOnce([trigger]);

        withOriginatingTrigger("trigger-1", () =>
          withCausation(["agent-1"], () =>
            dispatchEvent(
              "org-1",
              "ws-1",
              cardEvent("card.updated", { id: "c1" }),
            ),
          ),
        );
        await flushMicrotasks();

        expect(decisionLines()[0]).toMatchObject({
          triggerId: "trigger-2",
          originatingTriggerId: "trigger-1",
          decision: "fired",
        });
      });

      it("logs identifiers only — never the event payload's user content", async () => {
        const trigger = makeEventTrigger({ id: "trigger-1" });
        mockDb.where.mockResolvedValueOnce([]).mockResolvedValueOnce([trigger]);

        dispatchEvent(
          "org-1",
          "ws-1",
          cardEvent("card.updated", {
            id: "c1",
            title: "Board the quarterly acquisition",
            body: "Confidential body text",
          }),
        );
        await flushMicrotasks();

        const logged = JSON.stringify(mockLogger.info.mock.calls);
        expect(logged).not.toContain("Board the quarterly acquisition");
        expect(logged).not.toContain("Confidential body text");
      });

      it("records no decision for a filtered-out trigger, even when its own agent caused the event", async () => {
        // Otherwise a filter mismatch would masquerade as loop suppression:
        // the Operator would read `skipped_self_actor` on a Trigger this event
        // never selected in the first place.
        const trigger = makeEventTrigger({
          id: "trigger-1",
          agentId: "agent-1",
          config: {
            events: ["card.updated"],
            filters: { boardId: "board-1" },
          },
        });
        mockDb.where.mockResolvedValueOnce([]).mockResolvedValueOnce([trigger]);

        withCausation(["agent-1"], () =>
          dispatchEvent(
            "org-1",
            "ws-1",
            cardEvent("card.updated", { id: "c1", boardId: "board-2" }),
          ),
        );
        await flushMicrotasks();

        expect(mockFireTrigger).not.toHaveBeenCalled();
        expect(decisionLines()).toEqual([]);
      });

      it("records no decision for a trigger an event filter ruled out", async () => {
        const trigger = makeEventTrigger({
          id: "trigger-1",
          config: {
            events: ["card.updated"],
            filters: { boardId: "board-1" },
          },
        });
        mockDb.where.mockResolvedValueOnce([]).mockResolvedValueOnce([trigger]);

        dispatchEvent(
          "org-1",
          "ws-1",
          cardEvent("card.updated", { id: "c1", boardId: "board-2" }),
        );
        await flushMicrotasks();

        expect(decisionLines()).toEqual([]);
      });
    });

    it("should skip a trigger when its own agent caused the event", async () => {
      const trigger = makeEventTrigger({ agentId: "agent-1" });
      mockDb.where.mockResolvedValueOnce([]).mockResolvedValueOnce([trigger]);

      withCausation(["agent-1"], () =>
        dispatchEvent("org-1", "ws-1", cardEvent("card.updated", { id: "c1" })),
      );
      await flushMicrotasks();

      expect(mockFireTrigger).not.toHaveBeenCalled();
    });

    it("should skip a trigger when a sub-agent of its own agent caused the event (depth 1)", async () => {
      const trigger = makeEventTrigger({ agentId: "agent-1" });
      mockDb.where.mockResolvedValueOnce([]).mockResolvedValueOnce([trigger]);

      // The run's chain is the parent Agent plus the delegate beneath it.
      withCausation(["agent-1", "sub-1"], () =>
        dispatchEvent("org-1", "ws-1", cardEvent("card.updated", { id: "c1" })),
      );
      await flushMicrotasks();

      expect(mockFireTrigger).not.toHaveBeenCalled();
    });

    it("should skip a trigger when a sub-agent of its own agent caused the event (depth 2+)", async () => {
      const trigger = makeEventTrigger({ agentId: "agent-1" });
      mockDb.where.mockResolvedValueOnce([]).mockResolvedValueOnce([trigger]);

      withCausation(["agent-1", "sub-1", "sub-2"], () =>
        dispatchEvent("org-1", "ws-1", cardEvent("card.updated", { id: "c1" })),
      );
      await flushMicrotasks();

      expect(mockFireTrigger).not.toHaveBeenCalled();
    });

    it("should fire on a human event even when the trigger's agent previously touched the card", async () => {
      const trigger = makeEventTrigger({ agentId: "agent-1" });
      mockDb.where.mockResolvedValueOnce([]).mockResolvedValueOnce([trigger]);

      // Human write path supplies no actor, even though the card row still
      // carries a stale lastEditedByAgentId from a prior agent edit.
      dispatchEvent(
        "org-1",
        "ws-1",
        cardEvent("card.updated", { id: "c1", lastEditedByAgentId: "agent-1" }),
      );
      await flushMicrotasks();

      expect(mockFireTrigger).toHaveBeenCalled();
    });

    it("should fire when a different agent caused the event", async () => {
      const trigger = makeEventTrigger({ agentId: "agent-1" });
      mockDb.where.mockResolvedValueOnce([]).mockResolvedValueOnce([trigger]);

      // A genuinely unrelated Agent, with no delegation relationship to the
      // trigger's Agent, still fires it.
      withCausation(["agent-2"], () =>
        dispatchEvent("org-1", "ws-1", cardEvent("card.updated", { id: "c1" })),
      );
      await flushMicrotasks();

      expect(mockFireTrigger).toHaveBeenCalled();
    });

    it("should not apply the self-actor guard to triggers without an agentId", async () => {
      const trigger = makeEventTrigger({ agentId: null });
      mockDb.where.mockResolvedValueOnce([]).mockResolvedValueOnce([trigger]);

      withCausation(["agent-1"], () =>
        dispatchEvent("org-1", "ws-1", cardEvent("card.updated", { id: "c1" })),
      );
      await flushMicrotasks();

      expect(mockFireTrigger).toHaveBeenCalled();
    });

    it("should dispatch to both webhooks and triggers for the same event", async () => {
      const webhook = makeWebhook();
      const trigger = makeEventTrigger();
      mockDb.where
        .mockResolvedValueOnce([webhook])
        .mockResolvedValueOnce([trigger]);

      dispatchEvent("org-1", "ws-1", cardEvent("card.created", { id: "c1" }));
      await flushMicrotasks();

      expect(mockDeliverWebhook).toHaveBeenCalledTimes(1);
      expect(mockFireTrigger).toHaveBeenCalledTimes(1);
    });

    it("should not fire a trigger on its own agent's notification writes", async () => {
      const trigger = makeEventTrigger({
        agentId: "agent-1",
        config: { events: ["notification.created"], filters: undefined },
      });

      for (const payload of [
        notificationEvent("notification.created"),
        notificationEvent("notification.updated"),
        {
          event: "notification.dismissed",
          data: { notificationId: "n-1" },
        } as const,
      ]) {
        mockDb.where.mockClear();
        vi.mocked(mockFireTrigger).mockClear();
        mockDb.where.mockResolvedValueOnce([]).mockResolvedValueOnce([trigger]);

        withCausation(["agent-1"], () =>
          dispatchEvent("org-1", "ws-1", payload),
        );
        await flushMicrotasks();

        expect(mockFireTrigger).not.toHaveBeenCalled();
      }
    });

    it("should not fire a trigger on its own agent's notification writes under delegation", async () => {
      const trigger = makeEventTrigger({
        agentId: "agent-1",
        config: { events: ["notification.created"], filters: undefined },
      });
      mockDb.where.mockResolvedValueOnce([]).mockResolvedValueOnce([trigger]);

      withCausation(["agent-1", "sub-1"], () =>
        dispatchEvent(
          "org-1",
          "ws-1",
          notificationEvent("notification.created"),
        ),
      );
      await flushMicrotasks();

      expect(mockFireTrigger).not.toHaveBeenCalled();
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

      const created = cardEvent("card.created", { id: "c1" });
      withCausation(["agent-1"], () => dispatchEvent("org-1", "ws-1", created));
      await flushMicrotasks();

      // Every subscribed Webhook still receives the event even though one of
      // the triggers was suppressed.
      expect(mockDeliverWebhook).toHaveBeenCalledTimes(1);
      // The suppressed trigger's run never starts, but the unrelated one does.
      expect(mockFireTrigger).toHaveBeenCalledTimes(1);
      expect(mockFireTrigger).toHaveBeenCalledWith(unrelated, {
        kind: "event",
        payload: created,
        entityId: "c1",
      });
    });
  });
});
