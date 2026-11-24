import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  resetMockDb,
  seedDb,
  type FakeDb,
  type Row,
  type Store,
} from "../test-utils.ts";

vi.mock("./event-dispatch.ts", () => ({
  dispatchEvent: vi.fn(),
}));

import type { db } from "../index.ts";
import { ConflictError, NotFoundError, ValidationError } from "../errors.ts";
import { dispatchEvent } from "./event-dispatch.ts";
import {
  KANBAN_CARD_HISTORY_LIMIT,
  type EventTriggerEvent,
} from "@platypus/schemas";
import {
  applyBodyDiff,
  bulkUpdateCards,
  changedCardFields,
  copyCard,
  createCard,
  keepKnownLabelIds,
  moveCard,
  placeCardInColumn,
  calculateCardPosition,
  rebalancedPositions,
  requireKnownLabelIds,
  requireValidAssignees,
  updateCard,
} from "./kanban-card.ts";
import { updateCommentBody, type CommentRow } from "./kanban-comment.ts";
import type { CardRow, KanbanContext } from "./kanban-shared.ts";

type Database = typeof db;

const dispatched = (
  event: EventTriggerEvent,
  data: Record<string, unknown>,
) => ({
  event,
  data: expect.objectContaining(data) as unknown,
});

const scope = { orgId: "org-1", workspaceId: "ws-1" };
const ctx: KanbanContext = { ...scope, actor: { agentId: "agent-1" } };

const at = (iso: string) => new Date(iso);

const world = (extra: Store = {}): Store => ({
  kanban_board: [
    {
      id: "board-1",
      workspaceId: "ws-1",
      name: "Work",
      labels: [
        { id: "lbl-a", name: "Urgent", color: "#000" },
        { id: "lbl-b", name: "Later", color: "#111" },
      ],
      createdAt: at("2026-01-01T00:00:00.000Z"),
      updatedAt: at("2026-01-01T00:00:00.000Z"),
    },
  ],
  kanban_column: [
    {
      id: "col-old",
      boardId: "board-1",
      name: "Doing",
      position: 1,
      createdAt: at("2026-01-01T00:00:00.000Z"),
      updatedAt: at("2026-01-01T00:00:00.000Z"),
    },
    {
      id: "col-new",
      boardId: "board-1",
      name: "Done",
      position: 2,
      createdAt: at("2026-01-01T00:00:00.000Z"),
      updatedAt: at("2026-01-01T00:00:00.000Z"),
    },
  ],
  ...extra,
});

const card = (id: string, columnId: string, extra: Row = {}): Row => ({
  id,
  columnId,
  title: id,
  body: null,
  labelIds: [],
  assignees: [],
  priority: "none",
  dueDate: null,
  position: 1,
  createdByUserId: null,
  createdByAgentId: "agent-1",
  lastEditedByUserId: null,
  lastEditedByAgentId: null,
  createdAt: at("2026-01-01T00:00:00.000Z"),
  updatedAt: at("2026-01-01T00:00:00.000Z"),
  ...extra,
});

const seed = (extra: Store = {}) => {
  const fake = seedDb(world(extra));
  return { fake, database: fake.handle as Database };
};

const cardIn = (fake: FakeDb, id: string) =>
  fake.tables.kanban_card.find((row) => row.id === id);

const historyOf = (fake: FakeDb, cardId: string) =>
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- a table no test seeded or wrote is absent
  (fake.tables.kanban_card_history ?? []).filter(
    (row) => row.cardId === cardId,
  );

type Handle = Record<string | symbol, (...args: unknown[]) => unknown>;

const handleMissingFullRows = (fake: FakeDb): Database => {
  const handle = fake.handle as Handle;
  return new Proxy(handle, {
    get(target, property) {
      const value = target[property];
      if (typeof value !== "function") return value;
      if (property !== "select") return value.bind(target);
      return (selection?: unknown) => {
        if (selection === undefined) fake.tables.kanban_card.length = 0;
        return value.call(target, selection);
      };
    },
  }) as unknown as Database;
};

describe("kanban module", () => {
  beforeEach(() => {
    resetMockDb();
    vi.mocked(dispatchEvent).mockClear();
  });

  describe("label rules", () => {
    it("rejects a create that names a label the board does not have", async () => {
      const { database } = seed();

      await expect(
        requireKnownLabelIds(database, "board-1", ["lbl-a", "lbl-ghost"]),
      ).rejects.toThrow(ValidationError);
    });

    it("accepts a create whose labels are all on the board", async () => {
      const { database } = seed();

      await expect(
        requireKnownLabelIds(database, "board-1", ["lbl-b"]),
      ).resolves.toBeUndefined();
    });

    it("drops unknown labels on an update, keeping the submitted order", async () => {
      const { database } = seed();

      expect(
        await keepKnownLabelIds(database, "board-1", [
          "lbl-b",
          "lbl-ghost",
          "lbl-a",
        ]),
      ).toEqual(["lbl-b", "lbl-a"]);
    });

    it("asks the board nothing when no labels were submitted", async () => {
      const { fake, database } = seed();

      expect(await keepKnownLabelIds(database, "board-1", [])).toEqual([]);
      expect(fake.queries).toEqual([]);
    });
  });

  describe("assignee rules", () => {
    it("passes an org member", async () => {
      const { database } = seed({
        organization_member: [
          { id: "om-1", organizationId: "org-1", userId: "user-1" },
        ],
      });

      await expect(
        requireValidAssignees(
          database,
          [{ type: "user", id: "user-1" }],
          scope,
        ),
      ).resolves.toBeUndefined();
    });

    it("passes a super admin, who holds no membership row", async () => {
      const { database } = seed({
        user: [{ id: "admin-1", role: "admin" }],
      });

      await expect(
        requireValidAssignees(
          database,
          [{ type: "user", id: "admin-1" }],
          scope,
        ),
      ).resolves.toBeUndefined();
    });

    it("rejects a user who is neither", async () => {
      const { database } = seed();

      await expect(
        requireValidAssignees(
          database,
          [{ type: "user", id: "outsider" }],
          scope,
        ),
      ).rejects.toThrow("Invalid user assignee");
    });

    it("passes a Shared agent attached to this workspace", async () => {
      const { database } = seed({
        agent: [
          { id: "shared-agent", organizationId: "org-1", workspaceId: null },
        ],
        attachment: [
          {
            id: "att-1",
            workspaceId: "ws-1",
            resourceType: "agent",
            resourceId: "shared-agent",
          },
        ],
      });

      await expect(
        requireValidAssignees(
          database,
          [{ type: "agent", id: "shared-agent" }],
          scope,
        ),
      ).resolves.toBeUndefined();
    });

    it("rejects an agent that is not visible here", async () => {
      const { database } = seed({
        agent: [
          {
            id: "someone-elses-agent",
            organizationId: "org-2",
            workspaceId: null,
          },
        ],
      });

      await expect(
        requireValidAssignees(
          database,
          [{ type: "agent", id: "someone-elses-agent" }],
          scope,
        ),
      ).rejects.toThrow("Invalid agent assignee");
    });

    it("asks nothing when there are no assignees", async () => {
      const { fake, database } = seed();

      await expect(
        requireValidAssignees(database, [], scope),
      ).resolves.toBeUndefined();
      expect(fake.queries).toEqual([]);
    });
  });

  describe("placeCardInColumn", () => {
    it("appends past the last card when no anchor is given", async () => {
      const { database } = seed({
        kanban_card: [card("card-1", "col-old", { position: 3 })],
      });

      expect(
        await placeCardInColumn(database, {
          columnId: "col-old",
          afterCardId: undefined,
        }),
      ).toBe(4);
    });

    it("starts at 1 in an empty column", async () => {
      const { database } = seed();

      expect(
        await placeCardInColumn(database, {
          columnId: "col-old",
          afterCardId: undefined,
        }),
      ).toBe(1);
    });

    it("halves the gap ahead of the first card for a null anchor", async () => {
      const { fake, database } = seed({
        kanban_card: [
          card("card-2", "col-old", { position: 1.0 }),
          card("card-3", "col-old", { position: 2.0 }),
        ],
      });

      expect(
        await placeCardInColumn(database, {
          columnId: "col-old",
          afterCardId: null,
        }),
      ).toBe(0.5);
      expect(cardIn(fake, "card-2")?.position).toBe(1);
      expect(cardIn(fake, "card-3")?.position).toBe(2);
    });

    it("leaves the moved card out of the ordering it is re-entering", async () => {
      const { database } = seed({
        kanban_card: [
          card("card-1", "col-old", { position: 1.0 }),
          card("card-2", "col-old", { position: 2.0 }),
        ],
      });

      expect(
        await placeCardInColumn(database, {
          columnId: "col-old",
          afterCardId: "card-2",
          excludeCardId: "card-1",
        }),
      ).toBe(3);
    });

    it("renumbers the column when the gap has collapsed", async () => {
      const { fake, database } = seed({
        kanban_card: [
          card("card-2", "col-old", { position: 1.0 }),
          card("card-3", "col-old", { position: 1.0000001 }),
        ],
      });

      expect(
        await placeCardInColumn(database, {
          columnId: "col-old",
          afterCardId: "card-2",
        }),
      ).toBe(2);

      expect(cardIn(fake, "card-2")?.position).toBe(1);
      expect(cardIn(fake, "card-3")?.position).toBe(3);
    });

    it("rejects an anchor that is not in the column", async () => {
      const { database } = seed({
        kanban_card: [card("card-2", "col-old", { position: 1.0 })],
      });

      await expect(
        placeCardInColumn(database, {
          columnId: "col-old",
          afterCardId: "ghost",
        }),
      ).rejects.toThrow("afterCardId not found in column");
    });
  });

  describe("calculateCardPosition", () => {
    describe("inserting at the top (afterCardId = null)", () => {
      it("should return position 1.0 when column is empty", () => {
        const result = calculateCardPosition([], null);
        expect(result.position).toBe(1.0);
        expect(result.needsRebalance).toBe(false);
        expect(result.afterIndex).toBe(-1);
      });

      it("should return half the first card's position", () => {
        const cards = [{ id: "a", position: 2.0 }];
        const result = calculateCardPosition(cards, null);
        expect(result.position).toBe(1.0);
        expect(result.needsRebalance).toBe(false);
      });
    });

    describe("inserting after a specific card", () => {
      it("should add 1.0 when inserting after the last card", () => {
        const cards = [
          { id: "a", position: 1.0 },
          { id: "b", position: 2.0 },
        ];
        const result = calculateCardPosition(cards, "b");
        expect(result.position).toBe(3.0);
        expect(result.afterIndex).toBe(1);
        expect(result.needsRebalance).toBe(false);
      });

      it("should compute midpoint when inserting between two cards", () => {
        const cards = [
          { id: "a", position: 1.0 },
          { id: "b", position: 3.0 },
        ];
        const result = calculateCardPosition(cards, "a");
        expect(result.position).toBe(2.0);
        expect(result.afterIndex).toBe(0);
      });

      it("should throw when afterCardId is not found", () => {
        const cards = [{ id: "a", position: 1.0 }];
        expect(() => calculateCardPosition(cards, "nonexistent")).toThrow(
          "afterCardId not found in column",
        );
      });
    });

    describe("rebalancing detection", () => {
      it("should flag needsRebalance when gap is less than 0.001", () => {
        const cards = [
          { id: "a", position: 1.0 },
          { id: "b", position: 1.0005 },
        ];
        const result = calculateCardPosition(cards, "a");
        expect(result.needsRebalance).toBe(true);
      });

      it("should not flag needsRebalance when gap is sufficient", () => {
        const cards = [
          { id: "a", position: 1.0 },
          { id: "b", position: 2.0 },
        ];
        const result = calculateCardPosition(cards, "a");
        expect(result.needsRebalance).toBe(false);
      });

      it("should not flag needsRebalance when inserting after the last card", () => {
        const cards = [{ id: "a", position: 1.0 }];
        const result = calculateCardPosition(cards, "a");
        expect(result.needsRebalance).toBe(false);
      });
    });
  });

  describe("rebalancedPositions", () => {
    it("leaves the slot just after the anchor free", () => {
      expect(
        rebalancedPositions([{ id: "a" }, { id: "b" }, { id: "c" }], 1),
      ).toEqual([
        { id: "a", position: 1 },
        { id: "b", position: 2 },
        { id: "c", position: 4 },
      ]);
    });
  });

  describe("applyBodyDiff", () => {
    it("applies search-replace pairs in order", () => {
      expect(
        applyBodyDiff("foo bar", [
          { search: "foo", replace: "qux" },
          { search: "bar", replace: "quux" },
        ]),
      ).toBe("qux quux");
    });

    it("adds content at either boundary", () => {
      expect(applyBodyDiff("body", { mode: "append", content: "!" })).toBe(
        "body!",
      );
      expect(applyBodyDiff("body", { mode: "prepend", content: "!" })).toBe(
        "!body",
      );
    });

    it("refuses a diff written against a body it does not match", () => {
      expect(() =>
        applyBodyDiff("body", [{ search: "missing", replace: "x" }]),
      ).toThrow(ValidationError);
    });
  });

  describe("changedCardFields", () => {
    const baseCard: CardRow = {
      id: "card-1",
      columnId: "col-1",
      title: "Title",
      body: "Body",
      labelIds: ["lbl-a", "lbl-b"],
      assignees: [
        { type: "user", id: "user-1" },
        { type: "agent", id: "agent-1" },
      ],
      dueDate: new Date("2026-01-01T00:00:00Z"),
      priority: "medium",
      position: 1,
      createdByUserId: "user-1",
      createdByAgentId: null,
      lastEditedByUserId: null,
      lastEditedByAgentId: null,
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
    };

    it("reports nothing when every value-bearing field is unchanged", () => {
      expect(changedCardFields(baseCard, { ...baseCard })).toEqual([]);
    });

    it("ignores bookkeeping columns even when they differ", () => {
      const next: CardRow = {
        ...baseCard,
        position: 99,
        updatedAt: new Date("2026-02-01T00:00:00Z"),
        lastEditedByUserId: "user-2",
        lastEditedByAgentId: "agent-2",
      };
      expect(changedCardFields(baseCard, next)).toEqual([]);
    });

    it("reports body when only the body differs", () => {
      expect(
        changedCardFields(baseCard, { ...baseCard, body: "New body" }),
      ).toEqual(["body"]);
    });

    it("does not report body when an empty editor echoes a null body back", () => {
      const empty: CardRow = { ...baseCard, body: null };
      expect(changedCardFields(empty, { ...empty, body: "" })).toEqual([]);
      expect(changedCardFields({ ...empty, body: "" }, empty)).toEqual([]);
    });

    it("does not report labelIds when the same set arrives in a different order", () => {
      expect(
        changedCardFields(baseCard, {
          ...baseCard,
          labelIds: ["lbl-b", "lbl-a"],
        }),
      ).toEqual([]);
    });

    it("reports labelIds when the set actually differs", () => {
      expect(
        changedCardFields(baseCard, { ...baseCard, labelIds: ["lbl-a"] }),
      ).toEqual(["labelIds"]);
    });

    it("does not report assignees when the same set arrives in a different order", () => {
      expect(
        changedCardFields(baseCard, {
          ...baseCard,
          assignees: [
            { type: "agent", id: "agent-1" },
            { type: "user", id: "user-1" },
          ],
        }),
      ).toEqual([]);
    });

    it("reports assignees when the set actually differs", () => {
      expect(
        changedCardFields(baseCard, {
          ...baseCard,
          assignees: [{ type: "user", id: "user-1" }],
        }),
      ).toEqual(["assignees"]);
    });

    it("compares dueDate by value, not by object identity", () => {
      expect(
        changedCardFields(baseCard, {
          ...baseCard,
          dueDate: new Date("2026-01-01T00:00:00Z"),
        }),
      ).toEqual([]);
      expect(
        changedCardFields(baseCard, {
          ...baseCard,
          dueDate: new Date("2026-03-01T00:00:00Z"),
        }),
      ).toEqual(["dueDate"]);
    });

    it("reports columnId when the column changes", () => {
      expect(
        changedCardFields(baseCard, { ...baseCard, columnId: "col-2" }),
      ).toEqual(["columnId"]);
    });

    it("reports priority and title changes", () => {
      expect(
        changedCardFields(baseCard, { ...baseCard, priority: "urgent" }),
      ).toEqual(["priority"]);
      expect(
        changedCardFields(baseCard, { ...baseCard, title: "New title" }),
      ).toEqual(["title"]);
    });
  });

  describe("moveCard", () => {
    it("dispatches card.moved with the previous column when the column changes", async () => {
      const { fake, database } = seed({
        kanban_card: [card("card-1", "col-old")],
      });

      await moveCard(database, ctx, {
        cardId: "card-1",
        columnId: "col-new",
        afterCardId: null,
      });

      expect(cardIn(fake, "card-1")).toMatchObject({
        columnId: "col-new",
        position: 1,
      });
      expect(dispatchEvent).toHaveBeenCalledWith(
        "org-1",
        "ws-1",
        dispatched("card.moved", {
          id: "card-1",
          columnId: "col-new",
          previousColumnId: "col-old",
          boardId: "board-1",
        }),
      );
      expect(dispatchEvent).toHaveBeenCalledWith(
        "org-1",
        "ws-1",
        dispatched("card.updated", {
          id: "card-1",
          boardId: "board-1",
          changedFields: ["columnId"],
        }),
      );
    });

    it("does not dispatch card.moved for a within-column reorder", async () => {
      const { fake, database } = seed({
        kanban_card: [
          card("card-1", "col-old", { position: 1 }),
          card("card-2", "col-old", { position: 2 }),
        ],
      });

      await moveCard(database, ctx, {
        cardId: "card-1",
        columnId: "col-old",
        afterCardId: "card-2",
      });

      expect(cardIn(fake, "card-1")?.position).toBe(3);
      expect(dispatchEvent).not.toHaveBeenCalledWith(
        "org-1",
        "ws-1",
        dispatched("card.moved", {}),
      );
      expect(dispatchEvent).toHaveBeenCalledWith(
        "org-1",
        "ws-1",
        dispatched("card.updated", {
          id: "card-1",
          boardId: "board-1",
          changedFields: [],
        }),
      );
    });

    it("moves the card when the expected column still matches", async () => {
      const { fake, database } = seed({
        kanban_card: [card("card-1", "col-old")],
      });

      const result = await moveCard(database, ctx, {
        cardId: "card-1",
        columnId: "col-new",
        afterCardId: null,
        expectedColumnId: "col-old",
      });

      expect(result.card.columnId).toBe("col-new");
      expect(cardIn(fake, "card-1")?.columnId).toBe("col-new");
    });

    it("refuses the move when the card has left the expected column", async () => {
      const { fake, database } = seed({
        kanban_card: [card("card-1", "col-old", { position: 4 })],
      });

      await expect(
        moveCard(database, ctx, {
          cardId: "card-1",
          columnId: "col-new",
          afterCardId: null,
          expectedColumnId: "col-stale",
        }),
      ).rejects.toThrow(ConflictError);

      expect(cardIn(fake, "card-1")).toMatchObject({
        columnId: "col-old",
        position: 4,
      });
      expect(dispatchEvent).not.toHaveBeenCalled();
    });

    it("does not name the card's current column in the refusal", async () => {
      const { database } = seed({
        kanban_column: [
          {
            id: "col-note-processing",
            boardId: "board-1",
            name: "Note processing",
            position: 1,
            createdAt: at("2026-01-01T00:00:00.000Z"),
            updatedAt: at("2026-01-01T00:00:00.000Z"),
          },
          {
            id: "col-new",
            boardId: "board-1",
            name: "Done",
            position: 2,
            createdAt: at("2026-01-01T00:00:00.000Z"),
            updatedAt: at("2026-01-01T00:00:00.000Z"),
          },
        ],
        kanban_card: [card("card-1", "col-note-processing")],
      });

      let message = "";
      try {
        await moveCard(database, ctx, {
          cardId: "card-1",
          columnId: "col-new",
          afterCardId: null,
          expectedColumnId: "col-stale",
        });
      } catch (caught) {
        message = (caught as Error).message;
      }

      expect(message).toContain("expected column");
      expect(message).not.toContain("col-note-processing");
    });
  });

  describe("updateCard", () => {
    it("emits an empty changedFields when the update echoes the card back unchanged", async () => {
      const { fake, database } = seed({
        kanban_card: [
          card("card-1", "col-old", {
            title: "Title",
            body: "Body",
            priority: "medium",
          }),
        ],
      });

      await updateCard(database, ctx, "card-1", {
        title: "Title",
        body: "Body",
        priority: "medium",
      });

      expect(cardIn(fake, "card-1")).toMatchObject({
        title: "Title",
        body: "Body",
        priority: "medium",
      });
      expect(dispatchEvent).toHaveBeenCalledWith(
        "org-1",
        "ws-1",
        dispatched("card.updated", { changedFields: [] }),
      );
    });

    it("reports body when the change arrives as a plain edit", async () => {
      const { fake, database } = seed({
        kanban_card: [card("card-1", "col-old", { body: "Old body" })],
      });

      await updateCard(database, ctx, "card-1", { body: "New body" });

      expect(cardIn(fake, "card-1")?.body).toBe("New body");
      expect(dispatchEvent).toHaveBeenCalledWith(
        "org-1",
        "ws-1",
        dispatched("card.updated", { changedFields: ["body"] }),
      );
    });

    it("reports body when the change arrives as a bodyDiff", async () => {
      const { fake, database } = seed({
        kanban_card: [card("card-1", "col-old", { body: "Old body" })],
      });

      await updateCard(database, ctx, "card-1", {
        bodyDiff: [{ search: "Old", replace: "New" }],
      });

      expect(cardIn(fake, "card-1")?.body).toBe("New body");
      expect(dispatchEvent).toHaveBeenCalledWith(
        "org-1",
        "ws-1",
        dispatched("card.updated", { changedFields: ["body"] }),
      );
    });
  });

  describe("card history", () => {
    it("records one entry naming every field that moved, not one per field", async () => {
      const { fake, database } = seed({
        kanban_card: [
          card("card-1", "col-old", { title: "Old", priority: "low" }),
        ],
      });

      await updateCard(database, ctx, "card-1", {
        title: "New",
        priority: "high",
      });

      expect(historyOf(fake, "card-1")).toEqual([
        expect.objectContaining({
          cardId: "card-1",
          kind: "updated",
          changes: [
            { field: "title", before: "Old", after: "New" },
            { field: "priority", before: "low", after: "high" },
          ],
        }),
      ]);
    });

    it("records a body edit without either version of the text", async () => {
      const { fake, database } = seed({
        kanban_card: [card("card-1", "col-old", { body: "the old body" })],
      });

      await updateCard(database, ctx, "card-1", { body: "the new body" });

      expect(historyOf(fake, "card-1")).toEqual([
        expect.objectContaining({ changes: [{ field: "body" }] }),
      ]);
      expect(JSON.stringify(historyOf(fake, "card-1"))).not.toContain(
        "the old body",
      );
      expect(JSON.stringify(historyOf(fake, "card-1"))).not.toContain(
        "the new body",
      );
    });

    it("writes nothing when the write moved no tracked field", async () => {
      const { fake, database } = seed({
        kanban_card: [card("card-1", "col-old", { title: "Same" })],
      });

      await updateCard(database, ctx, "card-1", { title: "Same" });

      expect(historyOf(fake, "card-1")).toEqual([]);
    });

    it("attributes the entry to the acting agent", async () => {
      const { fake, database } = seed({
        kanban_card: [card("card-1", "col-old", { title: "A" })],
      });

      await updateCard(database, ctx, "card-1", { title: "B" });

      expect(historyOf(fake, "card-1")[0]).toMatchObject({
        actorAgentId: "agent-1",
      });
      expect(historyOf(fake, "card-1")[0]).not.toHaveProperty("actorUserId");
    });

    it("attributes the entry to the acting user", async () => {
      const userCtx: KanbanContext = { ...scope, actor: { userId: "user-1" } };
      const { fake, database } = seed({
        kanban_card: [card("card-1", "col-old", { title: "A" })],
      });

      await updateCard(database, userCtx, "card-1", { title: "B" });

      expect(historyOf(fake, "card-1")[0]).toMatchObject({
        actorUserId: "user-1",
      });
      expect(historyOf(fake, "card-1")[0]).not.toHaveProperty("actorAgentId");
    });

    it("snapshots label names rather than storing bare ids", async () => {
      const { fake, database } = seed({
        kanban_card: [card("card-1", "col-old", { labelIds: [] })],
      });

      await updateCard(database, ctx, "card-1", { labelIds: ["lbl-a"] });

      expect(historyOf(fake, "card-1")[0]).toMatchObject({
        changes: [
          {
            field: "labelIds",
            before: [],
            after: [{ id: "lbl-a", name: "Urgent" }],
          },
        ],
      });
    });

    it("records a move as the columns it went between", async () => {
      const { fake, database } = seed({
        kanban_card: [card("card-1", "col-old")],
      });

      await moveCard(database, ctx, {
        cardId: "card-1",
        columnId: "col-new",
        afterCardId: null,
      });

      expect(historyOf(fake, "card-1")).toEqual([
        expect.objectContaining({
          kind: "updated",
          changes: [
            {
              field: "columnId",
              before: { id: "col-old", name: "Doing" },
              after: { id: "col-new", name: "Done" },
            },
          ],
        }),
      ]);
    });

    it("records a creation as the column the card appeared in", async () => {
      const { fake, database } = seed();

      const { card: created } = await createCard(database, ctx, {
        columnId: "col-old",
        title: "New",
      });

      expect(cardIn(fake, created.id)).toMatchObject({
        columnId: "col-old",
        title: "New",
      });
      expect(historyOf(fake, created.id)).toEqual([
        expect.objectContaining({
          cardId: created.id,
          kind: "created",
          changes: [
            {
              field: "columnId",
              before: null,
              after: { id: "col-old", name: "Doing" },
            },
          ],
        }),
      ]);
    });

    it("trims past the cap on the same write that appended", async () => {
      const existing = Array.from(
        { length: KANBAN_CARD_HISTORY_LIMIT + 1 },
        (_, index) => ({
          id: `hist-${String(index).padStart(3, "0")}`,
          cardId: "card-1",
          kind: "updated",
          changes: [{ field: "title" }],
          createdAt: new Date(Date.UTC(2026, 0, 1, 0, index)),
        }),
      );
      const { fake, database } = seed({
        kanban_card: [card("card-1", "col-old", { title: "A" })],
        kanban_card_history: existing,
      });

      await updateCard(database, ctx, "card-1", { title: "B" });

      const entries = historyOf(fake, "card-1");
      expect(entries).toHaveLength(KANBAN_CARD_HISTORY_LIMIT);
      expect(entries.map((entry) => entry.id)).not.toContain("hist-000");
      expect(entries.map((entry) => entry.id)).toContain("hist-050");
    });
  });

  describe("bulkUpdateCards", () => {
    it("reports the cards it could not reach and updates the rest", async () => {
      const { fake, database } = seed({
        kanban_card: [card("card-1", "col-old", { priority: "low" })],
      });

      expect(
        await bulkUpdateCards(database, ctx, {
          cardIds: ["card-1", "card-2"],
          priority: "high",
        }),
      ).toEqual([
        { cardId: "card-1", success: true },
        { cardId: "card-2", success: false, error: "Card not found" },
      ]);
      expect(cardIn(fake, "card-1")?.priority).toBe("high");
      expect(dispatchEvent).toHaveBeenCalledWith(
        "org-1",
        "ws-1",
        dispatched("card.updated", { changedFields: ["priority"] }),
      );
    });

    it("refuses the whole batch when the assignee cannot work here", async () => {
      const { fake, database } = seed({
        kanban_card: [card("card-1", "col-old", { priority: "low" })],
      });

      await expect(
        bulkUpdateCards(database, ctx, {
          cardIds: ["card-1"],
          assignees: [{ type: "user", id: "outsider" }],
        }),
      ).rejects.toThrow("Invalid user assignee");
      expect(cardIn(fake, "card-1")?.priority).toBe("low");
    });

    it("dispatches card.moved for a card whose column changes, but not for one that stays put", async () => {
      const { fake, database } = seed({
        kanban_card: [card("card-1", "col-old"), card("card-2", "col-new")],
      });

      await bulkUpdateCards(database, ctx, {
        cardIds: ["card-1", "card-2"],
        columnId: "col-new",
      });

      expect(cardIn(fake, "card-1")?.columnId).toBe("col-new");
      expect(cardIn(fake, "card-2")?.columnId).toBe("col-new");
      expect(dispatchEvent).toHaveBeenCalledWith(
        "org-1",
        "ws-1",
        dispatched("card.moved", {
          id: "card-1",
          previousColumnId: "col-old",
        }),
      );
      expect(dispatchEvent).not.toHaveBeenCalledWith(
        "org-1",
        "ws-1",
        dispatched("card.moved", { id: "card-2" }),
      );
      expect(dispatchEvent).toHaveBeenCalledWith(
        "org-1",
        "ws-1",
        dispatched("card.updated", {
          id: "card-1",
          changedFields: ["columnId"],
        }),
      );
      expect(dispatchEvent).toHaveBeenCalledWith(
        "org-1",
        "ws-1",
        dispatched("card.updated", { id: "card-2", changedFields: [] }),
      );
    });
  });

  describe("copyCard", () => {
    it("throws NotFoundError when the source card is deleted before it is read", async () => {
      const fake = seedDb(world({ kanban_card: [card("card-1", "col-old")] }));

      await expect(
        copyCard(handleMissingFullRows(fake), ctx, {
          cardId: "card-1",
          columnId: "col-old",
        }),
      ).rejects.toThrow(new NotFoundError("Card not found"));
      expect(fake.tables.kanban_card).toEqual([]);
    });
  });

  describe("updateCommentBody", () => {
    it("throws NotFoundError when the comment is deleted before the write", async () => {
      const fake = seedDb(
        world({
          kanban_card: [card("card-1", "col-old")],
          kanban_card_comment: [
            { id: "comment-1", cardId: "card-1", body: "Before" },
          ],
        }),
        {
          onQuery: (query) => {
            if (
              query.kind === "update" &&
              query.table === "kanban_card_comment"
            ) {
              fake.tables.kanban_card_comment.length = 0;
            }
          },
        },
      );

      await expect(
        updateCommentBody(
          fake.handle as Database,
          { id: "comment-1" } as CommentRow,
          "Edited",
        ),
      ).rejects.toThrow(new NotFoundError("Comment not found"));
    });
  });
});
