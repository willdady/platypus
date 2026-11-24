import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  asDb,
  createMockDb,
  renderedWheres,
  type MockDb,
} from "../test-utils.ts";

vi.mock("./event-dispatch.ts", () => ({
  dispatchEvent: vi.fn(),
}));

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

const dispatched = (
  event: EventTriggerEvent,
  data: Record<string, unknown>,
) => ({
  event,
  data: expect.objectContaining(data) as unknown,
});

const scope = { orgId: "org-1", workspaceId: "ws-1" };
const ctx: KanbanContext = { ...scope, actor: { agentId: "agent-1" } };

describe("kanban module", () => {
  let db: MockDb;

  beforeEach(() => {
    db = createMockDb();
    vi.mocked(dispatchEvent).mockClear();
  });

  describe("label rules", () => {
    const boardHasLabels = (ids: string[]) =>
      db.limit.mockResolvedValue([{ labels: ids.map((id) => ({ id })) }]);

    it("rejects a create that names a label the board does not have", async () => {
      boardHasLabels(["lbl-a"]);

      await expect(
        requireKnownLabelIds(asDb(db), "board-1", ["lbl-a", "lbl-ghost"]),
      ).rejects.toThrow(ValidationError);
    });

    it("accepts a create whose labels are all on the board", async () => {
      boardHasLabels(["lbl-a", "lbl-b"]);

      await expect(
        requireKnownLabelIds(asDb(db), "board-1", ["lbl-b"]),
      ).resolves.toBeUndefined();
    });

    it("drops unknown labels on an update, keeping the submitted order", async () => {
      boardHasLabels(["lbl-a", "lbl-b"]);

      expect(
        await keepKnownLabelIds(asDb(db), "board-1", [
          "lbl-b",
          "lbl-ghost",
          "lbl-a",
        ]),
      ).toEqual(["lbl-b", "lbl-a"]);
    });

    it("asks the board nothing when no labels were submitted", async () => {
      expect(await keepKnownLabelIds(asDb(db), "board-1", [])).toEqual([]);
      expect(db.select).not.toHaveBeenCalled();
    });
  });

  describe("assignee rules", () => {
    it("passes an org member", async () => {
      db.where.mockResolvedValueOnce([{ userId: "user-1" }]);
      db.where.mockResolvedValueOnce([]);

      await expect(
        requireValidAssignees(
          asDb(db),
          [{ type: "user", id: "user-1" }],
          scope,
        ),
      ).resolves.toBeUndefined();
    });

    it("passes a super admin, who holds no membership row", async () => {
      db.where.mockResolvedValueOnce([]);
      db.where.mockResolvedValueOnce([{ id: "admin-1" }]);

      await expect(
        requireValidAssignees(
          asDb(db),
          [{ type: "user", id: "admin-1" }],
          scope,
        ),
      ).resolves.toBeUndefined();
    });

    it("rejects a user who is neither", async () => {
      db.where.mockResolvedValueOnce([]);
      db.where.mockResolvedValueOnce([]);

      await expect(
        requireValidAssignees(
          asDb(db),
          [{ type: "user", id: "outsider" }],
          scope,
        ),
      ).rejects.toThrow("Invalid user assignee");
    });

    it("passes a Shared agent attached to this workspace", async () => {
      db.where.mockResolvedValueOnce([]);
      db.where.mockResolvedValueOnce([
        { agent: { id: "shared-agent" }, attachment: { id: "att-1" } },
      ]);

      await expect(
        requireValidAssignees(
          asDb(db),
          [{ type: "agent", id: "shared-agent" }],
          scope,
        ),
      ).resolves.toBeUndefined();
    });

    it("rejects an agent that is not visible here", async () => {
      db.where.mockResolvedValueOnce([]);
      db.where.mockResolvedValueOnce([]);

      await expect(
        requireValidAssignees(
          asDb(db),
          [{ type: "agent", id: "someone-elses-agent" }],
          scope,
        ),
      ).rejects.toThrow("Invalid agent assignee");
    });

    it("asks nothing when there are no assignees", async () => {
      await expect(
        requireValidAssignees(asDb(db), [], scope),
      ).resolves.toBeUndefined();
      expect(db.select).not.toHaveBeenCalled();
    });
  });

  describe("placeCardInColumn", () => {
    it("appends past the last card when no anchor is given", async () => {
      db.where.mockResolvedValue([{ maxPos: 3 }]);

      expect(
        await placeCardInColumn(asDb(db), {
          columnId: "col-1",
          afterCardId: undefined,
        }),
      ).toBe(4);
    });

    it("starts at 1 in an empty column", async () => {
      db.where.mockResolvedValue([{ maxPos: null }]);

      expect(
        await placeCardInColumn(asDb(db), {
          columnId: "col-1",
          afterCardId: undefined,
        }),
      ).toBe(1);
    });

    it("halves the gap ahead of the first card for a null anchor", async () => {
      db.orderBy.mockResolvedValue([
        { id: "card-2", position: 1.0 },
        { id: "card-3", position: 2.0 },
      ]);

      expect(
        await placeCardInColumn(asDb(db), {
          columnId: "col-1",
          afterCardId: null,
        }),
      ).toBe(0.5);
      expect(db.update).not.toHaveBeenCalled();
    });

    it("leaves the moved card out of the ordering it is re-entering", async () => {
      db.orderBy.mockResolvedValue([
        { id: "card-1", position: 1.0 },
        { id: "card-2", position: 2.0 },
      ]);

      expect(
        await placeCardInColumn(asDb(db), {
          columnId: "col-1",
          afterCardId: "card-2",
          excludeCardId: "card-1",
        }),
      ).toBe(3);
    });

    it("renumbers the column when the gap has collapsed", async () => {
      db.orderBy.mockResolvedValue([
        { id: "card-2", position: 1.0 },
        { id: "card-3", position: 1.0000001 },
      ]);

      expect(
        await placeCardInColumn(asDb(db), {
          columnId: "col-1",
          afterCardId: "card-2",
        }),
      ).toBe(2);

      expect(db.set.mock.calls.map((call) => call[0])).toEqual([
        expect.objectContaining({ position: 1 }),
        expect.objectContaining({ position: 3 }),
      ]);
    });

    it("rejects an anchor that is not in the column", async () => {
      db.orderBy.mockResolvedValue([{ id: "card-2", position: 1.0 }]);

      await expect(
        placeCardInColumn(asDb(db), {
          columnId: "col-1",
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
      db.limit
        .mockResolvedValueOnce([
          { id: "card-1", columnId: "col-old", boardId: "board-1" },
        ])
        .mockResolvedValueOnce([{ id: "col-new", boardId: "board-1" }])
        .mockResolvedValueOnce([
          { id: "col-old", name: "Old" },
          { id: "col-new", name: "New" },
        ]);
      db.orderBy.mockResolvedValueOnce([]);
      db.returning.mockResolvedValue([
        { id: "card-1", columnId: "col-new", position: 1 },
      ]);

      await moveCard(asDb(db), ctx, {
        cardId: "card-1",
        columnId: "col-new",
        afterCardId: null,
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
      db.limit
        .mockResolvedValueOnce([
          { id: "card-1", columnId: "col-1", boardId: "board-1" },
        ])
        .mockResolvedValueOnce([{ id: "col-1", boardId: "board-1" }]);
      db.orderBy.mockResolvedValueOnce([]);
      db.returning.mockResolvedValue([
        { id: "card-1", columnId: "col-1", position: 1 },
      ]);

      await moveCard(asDb(db), ctx, {
        cardId: "card-1",
        columnId: "col-1",
        afterCardId: null,
      });

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
      db.limit
        .mockResolvedValueOnce([
          { id: "card-1", columnId: "col-old", boardId: "board-1" },
        ])
        .mockResolvedValueOnce([{ id: "col-new", boardId: "board-1" }])
        .mockResolvedValueOnce([
          { id: "col-old", name: "Old" },
          { id: "col-new", name: "New" },
        ]);
      db.orderBy.mockResolvedValueOnce([]);
      db.returning.mockResolvedValue([
        { id: "card-1", columnId: "col-new", position: 1 },
      ]);

      const result = await moveCard(asDb(db), ctx, {
        cardId: "card-1",
        columnId: "col-new",
        afterCardId: null,
        expectedColumnId: "col-old",
      });

      expect(result.card.columnId).toBe("col-new");
    });

    it("constrains the update to the expected column", async () => {
      db.limit
        .mockResolvedValueOnce([
          { id: "card-1", columnId: "col-old", boardId: "board-1" },
        ])
        .mockResolvedValueOnce([{ id: "col-new", boardId: "board-1" }])
        .mockResolvedValueOnce([
          { id: "col-old", name: "Old" },
          { id: "col-new", name: "New" },
        ]);
      db.orderBy.mockResolvedValueOnce([]);
      db.returning.mockResolvedValue([
        { id: "card-1", columnId: "col-new", position: 1 },
      ]);

      await moveCard(asDb(db), ctx, {
        cardId: "card-1",
        columnId: "col-new",
        afterCardId: null,
        expectedColumnId: "col-old",
      });

      expect(renderedWheres(db)).toContainEqual({
        sql: `("kanban_card"."id" = $1 and "kanban_card"."column_id" = $2)`,
        params: ["card-1", "col-old"],
      });
    });

    it("leaves the update unconditional when no column is expected", async () => {
      db.limit
        .mockResolvedValueOnce([
          { id: "card-1", columnId: "col-old", boardId: "board-1" },
        ])
        .mockResolvedValueOnce([{ id: "col-new", boardId: "board-1" }])
        .mockResolvedValueOnce([
          { id: "col-old", name: "Old" },
          { id: "col-new", name: "New" },
        ]);
      db.orderBy.mockResolvedValueOnce([]);
      db.returning.mockResolvedValue([
        { id: "card-1", columnId: "col-new", position: 1 },
      ]);

      await moveCard(asDb(db), ctx, {
        cardId: "card-1",
        columnId: "col-new",
        afterCardId: null,
      });

      const rendered = renderedWheres(db);
      expect(rendered).toContainEqual({
        sql: `"kanban_card"."id" = $1`,
        params: ["card-1"],
      });
      expect(
        rendered.some(
          (query) =>
            query.sql.includes(`"kanban_card"."id" =`) &&
            query.sql.includes(`"kanban_card"."column_id" =`),
        ),
      ).toBe(false);
    });

    it("refuses the move when the card has left the expected column", async () => {
      db.limit
        .mockResolvedValueOnce([
          { id: "card-1", columnId: "col-old", boardId: "board-1" },
        ])
        .mockResolvedValueOnce([{ id: "col-new", boardId: "board-1" }])
        .mockResolvedValueOnce([
          { id: "col-old", name: "Old" },
          { id: "col-new", name: "New" },
        ]);
      db.orderBy.mockResolvedValueOnce([]);
      db.returning.mockResolvedValue([]);

      await expect(
        moveCard(asDb(db), ctx, {
          cardId: "card-1",
          columnId: "col-new",
          afterCardId: null,
          expectedColumnId: "col-stale",
        }),
      ).rejects.toThrow(ConflictError);

      expect(dispatchEvent).not.toHaveBeenCalled();
    });

    it("does not name the card's current column in the refusal", async () => {
      db.limit
        .mockResolvedValueOnce([
          { id: "card-1", columnId: "col-note-processing", boardId: "board-1" },
        ])
        .mockResolvedValueOnce([{ id: "col-new", boardId: "board-1" }]);
      db.orderBy.mockResolvedValueOnce([]);
      db.returning.mockResolvedValue([]);

      let message = "";
      try {
        await moveCard(asDb(db), ctx, {
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

    it("throws the refusal from inside the transaction so the rebalance rolls back", async () => {
      db.limit
        .mockResolvedValueOnce([
          { id: "card-1", columnId: "col-old", boardId: "board-1" },
        ])
        .mockResolvedValueOnce([{ id: "col-new", boardId: "board-1" }]);
      db.orderBy.mockResolvedValue([
        { id: "card-2", position: 1.0 },
        { id: "card-3", position: 1.0005 },
      ]);
      db.returning.mockResolvedValue([]);

      let threwInsideTransaction = false;
      db.transaction.mockImplementation(async (cb: (tx: MockDb) => unknown) => {
        try {
          return await cb(db);
        } catch (error) {
          threwInsideTransaction = true;
          throw error;
        }
      });

      await expect(
        moveCard(asDb(db), ctx, {
          cardId: "card-1",
          columnId: "col-new",
          afterCardId: "card-2",
          expectedColumnId: "col-stale",
        }),
      ).rejects.toThrow(ConflictError);

      expect(db.update.mock.calls.length).toBeGreaterThan(1);
      expect(threwInsideTransaction).toBe(true);
    });
  });

  describe("updateCard", () => {
    it("emits an empty changedFields when the update echoes the card back unchanged", async () => {
      const previous = {
        id: "card-1",
        columnId: "col-1",
        title: "Title",
        body: "Body",
        priority: "medium",
      };
      db.limit
        .mockResolvedValueOnce([
          { id: "card-1", columnId: "col-1", boardId: "board-1" },
        ])
        .mockResolvedValueOnce([previous]);
      db.returning.mockResolvedValue([{ ...previous }]);

      await updateCard(asDb(db), ctx, "card-1", {
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
      const previous = { id: "card-1", columnId: "col-1", body: "Old body" };
      db.limit
        .mockResolvedValueOnce([
          { id: "card-1", columnId: "col-1", boardId: "board-1" },
        ])
        .mockResolvedValueOnce([previous]);
      db.returning.mockResolvedValue([{ ...previous, body: "New body" }]);

      await updateCard(asDb(db), ctx, "card-1", { body: "New body" });

      expect(dispatchEvent).toHaveBeenCalledWith(
        "org-1",
        "ws-1",
        dispatched("card.updated", { changedFields: ["body"] }),
      );
    });

    it("reports body when the change arrives as a bodyDiff", async () => {
      const previous = { id: "card-1", columnId: "col-1", body: "Old body" };
      db.limit
        .mockResolvedValueOnce([
          { id: "card-1", columnId: "col-1", boardId: "board-1" },
        ])
        .mockResolvedValueOnce([previous]);
      db.returning.mockResolvedValue([{ ...previous, body: "New body" }]);

      await updateCard(asDb(db), ctx, "card-1", {
        bodyDiff: [{ search: "Old", replace: "New" }],
      });

      expect(dispatchEvent).toHaveBeenCalledWith(
        "org-1",
        "ws-1",
        dispatched("card.updated", { changedFields: ["body"] }),
      );
    });
  });

  describe("card history", () => {
    const entries = () =>
      db.values.mock.calls
        .map((call) => call[0] as Record<string, unknown>)
        .filter((value) => "kind" in value);

    it("records one entry naming every field that moved, not one per field", async () => {
      db.limit
        .mockResolvedValueOnce([
          { id: "card-1", columnId: "col-1", boardId: "board-1" },
        ])
        .mockResolvedValueOnce([
          { id: "card-1", columnId: "col-1", title: "Old", priority: "low" },
        ])
        .mockResolvedValueOnce([]);
      db.returning.mockResolvedValue([
        { id: "card-1", columnId: "col-1", title: "New", priority: "high" },
      ]);

      await updateCard(asDb(db), ctx, "card-1", {
        title: "New",
        priority: "high",
      });

      expect(entries()).toEqual([
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
      db.limit
        .mockResolvedValueOnce([
          { id: "card-1", columnId: "col-1", boardId: "board-1" },
        ])
        .mockResolvedValueOnce([
          { id: "card-1", columnId: "col-1", body: "the old body" },
        ])
        .mockResolvedValueOnce([]);
      db.returning.mockResolvedValue([
        { id: "card-1", columnId: "col-1", body: "the new body" },
      ]);

      await updateCard(asDb(db), ctx, "card-1", { body: "the new body" });

      expect(entries()).toEqual([
        expect.objectContaining({ changes: [{ field: "body" }] }),
      ]);
      expect(JSON.stringify(entries())).not.toContain("the old body");
      expect(JSON.stringify(entries())).not.toContain("the new body");
    });

    it("writes nothing when the write moved no tracked field", async () => {
      db.limit
        .mockResolvedValueOnce([
          { id: "card-1", columnId: "col-1", boardId: "board-1" },
        ])
        .mockResolvedValueOnce([
          { id: "card-1", columnId: "col-1", title: "Same" },
        ]);
      db.returning.mockResolvedValue([
        { id: "card-1", columnId: "col-1", title: "Same" },
      ]);

      await updateCard(asDb(db), ctx, "card-1", { title: "Same" });

      expect(entries()).toEqual([]);
    });

    it("attributes the entry to the acting agent", async () => {
      db.limit
        .mockResolvedValueOnce([
          { id: "card-1", columnId: "col-1", boardId: "board-1" },
        ])
        .mockResolvedValueOnce([
          { id: "card-1", columnId: "col-1", title: "A" },
        ])
        .mockResolvedValueOnce([]);
      db.returning.mockResolvedValue([
        { id: "card-1", columnId: "col-1", title: "B" },
      ]);

      await updateCard(asDb(db), ctx, "card-1", { title: "B" });

      expect(entries()[0]).toMatchObject({ actorAgentId: "agent-1" });
      expect(entries()[0]).not.toHaveProperty("actorUserId");
    });

    it("attributes the entry to the acting user", async () => {
      const userCtx: KanbanContext = { ...scope, actor: { userId: "user-1" } };
      db.limit
        .mockResolvedValueOnce([
          { id: "card-1", columnId: "col-1", boardId: "board-1" },
        ])
        .mockResolvedValueOnce([
          { id: "card-1", columnId: "col-1", title: "A" },
        ])
        .mockResolvedValueOnce([]);
      db.returning.mockResolvedValue([
        { id: "card-1", columnId: "col-1", title: "B" },
      ]);

      await updateCard(asDb(db), userCtx, "card-1", { title: "B" });

      expect(entries()[0]).toMatchObject({ actorUserId: "user-1" });
      expect(entries()[0]).not.toHaveProperty("actorAgentId");
    });

    it("snapshots label names rather than storing bare ids", async () => {
      db.limit
        .mockResolvedValueOnce([
          { id: "card-1", columnId: "col-1", boardId: "board-1" },
        ])
        .mockResolvedValueOnce([
          { id: "card-1", columnId: "col-1", labelIds: [] },
        ])
        .mockResolvedValueOnce([{ labels: [{ id: "lbl-a" }] }])
        .mockResolvedValueOnce([{ labels: [{ id: "lbl-a", name: "Urgent" }] }])
        .mockResolvedValueOnce([]);
      db.returning.mockResolvedValue([
        { id: "card-1", columnId: "col-1", labelIds: ["lbl-a"] },
      ]);

      await updateCard(asDb(db), ctx, "card-1", { labelIds: ["lbl-a"] });

      expect(entries()[0]).toMatchObject({
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
      db.limit
        .mockResolvedValueOnce([
          { id: "card-1", columnId: "col-old", boardId: "board-1" },
        ])
        .mockResolvedValueOnce([{ id: "col-new", boardId: "board-1" }])
        .mockResolvedValueOnce([
          { id: "col-old", name: "Doing" },
          { id: "col-new", name: "Done" },
        ])
        .mockResolvedValueOnce([]);
      db.orderBy.mockResolvedValueOnce([]);
      db.returning.mockResolvedValue([
        { id: "card-1", columnId: "col-new", position: 1 },
      ]);

      await moveCard(asDb(db), ctx, {
        cardId: "card-1",
        columnId: "col-new",
        afterCardId: null,
      });

      expect(entries()).toEqual([
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
      db.where.mockReturnValueOnce(db).mockResolvedValueOnce([{ maxPos: 1 }]);
      db.limit
        .mockResolvedValueOnce([{ id: "col-1", boardId: "board-1" }])
        .mockResolvedValueOnce([{ id: "col-1", name: "Backlog" }])
        .mockResolvedValueOnce([]);
      db.returning.mockResolvedValue([{ id: "card-1", columnId: "col-1" }]);

      await createCard(asDb(db), ctx, { columnId: "col-1", title: "New" });

      expect(entries()).toEqual([
        expect.objectContaining({
          cardId: "card-1",
          kind: "created",
          changes: [
            {
              field: "columnId",
              before: null,
              after: { id: "col-1", name: "Backlog" },
            },
          ],
        }),
      ]);
    });

    it("trims past the cap on the same write that appended", async () => {
      db.limit
        .mockResolvedValueOnce([
          { id: "card-1", columnId: "col-1", boardId: "board-1" },
        ])
        .mockResolvedValueOnce([
          { id: "card-1", columnId: "col-1", title: "A" },
        ])
        .mockResolvedValueOnce([]);
      db.returning.mockResolvedValue([
        { id: "card-1", columnId: "col-1", title: "B" },
      ]);

      await updateCard(asDb(db), ctx, "card-1", { title: "B" });

      expect(db.delete).toHaveBeenCalled();
      expect(db.limit).toHaveBeenCalledWith(KANBAN_CARD_HISTORY_LIMIT);
    });
  });

  describe("bulkUpdateCards", () => {
    it("reports the cards it could not reach and updates the rest", async () => {
      db.limit
        .mockResolvedValueOnce([
          { id: "card-1", columnId: "col-1", boardId: "board-1" },
        ])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: "card-1", priority: "low" }]);
      db.returning.mockResolvedValue([{ id: "card-1" }]);

      expect(
        await bulkUpdateCards(asDb(db), ctx, {
          cardIds: ["card-1", "card-2"],
          priority: "high",
        }),
      ).toEqual([
        { cardId: "card-1", success: true },
        { cardId: "card-2", success: false, error: "Card not found" },
      ]);
      expect(db.set).toHaveBeenCalledTimes(1);
      expect(dispatchEvent).toHaveBeenCalledWith(
        "org-1",
        "ws-1",
        dispatched("card.updated", { changedFields: ["priority"] }),
      );
    });

    it("throws NotFoundError when a card is deleted before its write", async () => {
      db.limit
        .mockResolvedValueOnce([
          { id: "card-1", columnId: "col-1", boardId: "board-1" },
        ])
        .mockResolvedValueOnce([{ id: "card-1", priority: "low" }]);
      db.returning.mockResolvedValueOnce([]);

      await expect(
        bulkUpdateCards(asDb(db), ctx, {
          cardIds: ["card-1"],
          priority: "high",
        }),
      ).rejects.toThrow(new NotFoundError("Card not found"));
      expect(dispatchEvent).not.toHaveBeenCalled();
    });

    it("refuses the whole batch when the assignee cannot work here", async () => {
      db.where.mockResolvedValueOnce([]);
      db.where.mockResolvedValueOnce([]);

      await expect(
        bulkUpdateCards(asDb(db), ctx, {
          cardIds: ["card-1"],
          assignees: [{ type: "user", id: "outsider" }],
        }),
      ).rejects.toThrow("Invalid user assignee");
      expect(db.update).not.toHaveBeenCalled();
    });

    it("dispatches card.moved for a card whose column changes, but not for one that stays put", async () => {
      db.limit
        .mockResolvedValueOnce([{ id: "col-new", boardId: "board-1" }])
        .mockResolvedValueOnce([
          { id: "card-1", columnId: "col-old", boardId: "board-1" },
        ])
        .mockResolvedValueOnce([
          { id: "card-2", columnId: "col-new", boardId: "board-1" },
        ])
        .mockResolvedValueOnce([{ id: "card-1", columnId: "col-old" }])
        .mockResolvedValueOnce([
          { id: "col-old", name: "Old" },
          { id: "col-new", name: "New" },
        ])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: "card-2", columnId: "col-new" }]);
      db.returning
        .mockResolvedValueOnce([
          { id: "card-1", columnId: "col-new", position: 1 },
        ])
        .mockResolvedValueOnce([
          { id: "card-2", columnId: "col-new", position: 2 },
        ]);

      await bulkUpdateCards(asDb(db), ctx, {
        cardIds: ["card-1", "card-2"],
        columnId: "col-new",
      });

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
      db.limit
        .mockResolvedValueOnce([
          { id: "card-1", columnId: "col-1", boardId: "board-1" },
        ])
        .mockResolvedValueOnce([{ id: "col-1", boardId: "board-1" }])
        .mockResolvedValueOnce([]);

      await expect(
        copyCard(asDb(db), ctx, { cardId: "card-1", columnId: "col-1" }),
      ).rejects.toThrow(new NotFoundError("Card not found"));
      expect(db.insert).not.toHaveBeenCalled();
    });
  });

  describe("updateCommentBody", () => {
    it("throws NotFoundError when the comment is deleted before the write", async () => {
      db.returning.mockResolvedValueOnce([]);

      await expect(
        updateCommentBody(
          asDb(db),
          { id: "comment-1" } as CommentRow,
          "Edited",
        ),
      ).rejects.toThrow(new NotFoundError("Comment not found"));
    });
  });
});
