import { describe, it, expect, vi, beforeEach } from "vitest";
import { asDb, createMockDb, type MockDb } from "../test-utils.ts";

vi.mock("./event-dispatch.ts", () => ({
  dispatchEvent: vi.fn(),
}));

// Imported after `test-utils`, which is what installs the suite-wide
// `drizzle-orm` mock — pulled in earlier, `eq` would be the real export and the
// predicate assertions below would have nothing to read.
import { eq } from "drizzle-orm";
import { kanbanCard as kanbanCardTable } from "../db/schema.ts";
import { ConflictError, NotFoundError, ValidationError } from "../errors.ts";
import { dispatchEvent } from "./event-dispatch.ts";
import {
  applyBodyDiff,
  bulkUpdateCards,
  changedCardFields,
  keepKnownLabelIds,
  moveCard,
  placeCardInColumn,
  rebalancedPositions,
  requireCard,
  requireKnownLabelIds,
  requireValidAssignees,
  updateCard,
  type CardRow,
  type KanbanContext,
} from "./kanban.ts";

const scope = { orgId: "org-1", workspaceId: "ws-1" };
const ctx: KanbanContext = { ...scope, actor: { agentId: "agent-1" } };

describe("kanban module", () => {
  let db: MockDb;

  beforeEach(() => {
    db = createMockDb();
    vi.mocked(dispatchEvent).mockClear();
  });

  describe("requireCard", () => {
    it("returns the card with the board it sits on", async () => {
      db.limit.mockResolvedValue([
        { id: "card-1", columnId: "col-1", boardId: "board-1" },
      ]);

      expect(await requireCard(asDb(db), scope, "card-1")).toEqual({
        id: "card-1",
        columnId: "col-1",
        boardId: "board-1",
      });
    });

    it("rejects a card that is out of scope", async () => {
      db.limit.mockResolvedValue([]);

      await expect(requireCard(asDb(db), scope, "card-1")).rejects.toThrow(
        NotFoundError,
      );
    });
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
      db.where.mockResolvedValueOnce([{ userId: "user-1" }]); // org member
      db.where.mockResolvedValueOnce([]); // super admin

      await expect(
        requireValidAssignees(
          asDb(db),
          [{ type: "user", id: "user-1" }],
          scope,
        ),
      ).resolves.toBeUndefined();
    });

    it("passes a super admin, who holds no membership row", async () => {
      db.where.mockResolvedValueOnce([]); // org member — none
      db.where.mockResolvedValueOnce([{ id: "admin-1" }]); // super admin

      await expect(
        requireValidAssignees(
          asDb(db),
          [{ type: "user", id: "admin-1" }],
          scope,
        ),
      ).resolves.toBeUndefined();
    });

    it("rejects a user who is neither", async () => {
      db.where.mockResolvedValueOnce([]); // org member — none
      db.where.mockResolvedValueOnce([]); // super admin — none

      await expect(
        requireValidAssignees(
          asDb(db),
          [{ type: "user", id: "outsider" }],
          scope,
        ),
      ).rejects.toThrow("Invalid user assignee");
    });

    it("passes a Shared agent attached to this workspace", async () => {
      db.where.mockResolvedValueOnce([]); // no workspace-scoped agent
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
      db.where.mockResolvedValueOnce([]); // no workspace-scoped agent
      db.where.mockResolvedValueOnce([]); // no attached org-scoped agent

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

      // Only card-2 remains, so landing after it appends rather than halving.
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
        { id: "card-3", position: 1.0000001 }, // gap < 0.001
      ]);

      expect(
        await placeCardInColumn(asDb(db), {
          columnId: "col-1",
          afterCardId: "card-2",
        }),
      ).toBe(2);

      // The card ahead keeps slot 1, the one behind moves to 3, and the
      // arriving card takes the 2 they leave between them.
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
        ]) // requireCard
        .mockResolvedValueOnce([{ id: "col-new", boardId: "board-1" }]); // requireColumn
      db.orderBy.mockResolvedValue([]); // placeCardInColumn
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
        "card.moved",
        expect.objectContaining({
          id: "card-1",
          columnId: "col-new",
          previousColumnId: "col-old",
          boardId: "board-1",
        }),
      );
      expect(dispatchEvent).toHaveBeenCalledWith(
        "org-1",
        "ws-1",
        "card.updated",
        expect.objectContaining({
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
        ]) // requireCard
        .mockResolvedValueOnce([{ id: "col-1", boardId: "board-1" }]); // requireColumn
      db.orderBy.mockResolvedValue([]); // placeCardInColumn
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
        "card.moved",
        expect.anything(),
      );
      expect(dispatchEvent).toHaveBeenCalledWith(
        "org-1",
        "ws-1",
        "card.updated",
        expect.objectContaining({
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
        ]) // requireCard
        .mockResolvedValueOnce([{ id: "col-new", boardId: "board-1" }]); // requireColumn
      db.orderBy.mockResolvedValue([]); // placeCardInColumn
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

    // Without these two the suite is vacuous: every refusal test below fakes
    // the outcome by stubbing zero rows, so an implementation that dropped the
    // predicate and kept only the `if (!row) throw` would pass them all. The
    // predicate itself is what has to be pinned.
    //
    // `drizzle-orm` is mocked suite-wide (see test-utils), so `eq()` returns
    // undefined and the assembled clause is unreadable from the `where` args.
    // Asserting on the `eq` mock's arguments is what remains observable. That
    // proves the predicate is built and handed to the UPDATE; it cannot prove
    // Postgres applies it, which no test here can without a real database.
    it("constrains the update to the expected column", async () => {
      vi.mocked(eq).mockClear();
      db.limit
        .mockResolvedValueOnce([
          { id: "card-1", columnId: "col-old", boardId: "board-1" },
        ])
        .mockResolvedValueOnce([{ id: "col-new", boardId: "board-1" }]);
      db.orderBy.mockResolvedValue([]);
      db.returning.mockResolvedValue([
        { id: "card-1", columnId: "col-new", position: 1 },
      ]);

      await moveCard(asDb(db), ctx, {
        cardId: "card-1",
        columnId: "col-new",
        afterCardId: null,
        expectedColumnId: "col-old",
      });

      expect(vi.mocked(eq)).toHaveBeenCalledWith(
        kanbanCardTable.columnId,
        "col-old",
      );
    });

    // The converse: with no expectation the update stays unconditional, or
    // every existing caller silently acquires a precondition it never asked
    // for. "col-old" is the card's current column, so a precondition applied
    // unconditionally from the pre-read would show up here.
    it("leaves the update unconditional when no column is expected", async () => {
      vi.mocked(eq).mockClear();
      db.limit
        .mockResolvedValueOnce([
          { id: "card-1", columnId: "col-old", boardId: "board-1" },
        ])
        .mockResolvedValueOnce([{ id: "col-new", boardId: "board-1" }]);
      db.orderBy.mockResolvedValue([]);
      db.returning.mockResolvedValue([
        { id: "card-1", columnId: "col-new", position: 1 },
      ]);

      await moveCard(asDb(db), ctx, {
        cardId: "card-1",
        columnId: "col-new",
        afterCardId: null,
      });

      expect(vi.mocked(eq)).not.toHaveBeenCalledWith(
        kanbanCardTable.columnId,
        "col-old",
      );
    });

    // The expectation is a predicate on the UPDATE, so a card that has moved on
    // matches no rows. A comparison against the pre-transaction read would pass
    // here and let the stale write land.
    it("refuses the move when the card has left the expected column", async () => {
      db.limit
        .mockResolvedValueOnce([
          { id: "card-1", columnId: "col-old", boardId: "board-1" },
        ]) // requireCard
        .mockResolvedValueOnce([{ id: "col-new", boardId: "board-1" }]); // requireColumn
      db.orderBy.mockResolvedValue([]); // placeCardInColumn
      db.returning.mockResolvedValue([]); // the predicate matched no row

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

    // The refusal sends the caller back to re-read the board rather than handing
    // it the winning writer's state, which is what invites an immediate
    // re-assertion of the losing move.
    it("does not name the card's current column in the refusal", async () => {
      db.limit
        .mockResolvedValueOnce([
          { id: "card-1", columnId: "col-note-processing", boardId: "board-1" },
        ])
        .mockResolvedValueOnce([{ id: "col-new", boardId: "board-1" }]);
      db.orderBy.mockResolvedValue([]);
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

      // Asserted first so the check below can't pass by the move succeeding.
      expect(message).toContain("expected column");
      expect(message).not.toContain("col-note-processing");
    });

    // `placeCardInColumn` renumbers the target column before the update runs, so
    // the refusal has to leave the transaction by throwing — a value returned
    // from the callback would commit that renumbering alongside a move that
    // never happened.
    //
    // The target column below has a collapsed gap (1.0 to 1.0005, under the
    // 0.001 threshold) and the card is dropped into it, so `placeCardInColumn`
    // takes its rebalance branch and issues the renumbering UPDATEs — the
    // writes the rollback has to discard. The mock has no rollback semantics,
    // so what is asserted is the property that makes a real transaction roll
    // back: the throw happens inside it.
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

      // Guards the setup: without the rebalance actually firing there are no
      // stray position writes to roll back, and this test would be asserting
      // the throw against a case that never had the problem. One update is the
      // move itself; the rebalance adds one per card it renumbers.
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
        ]) // requireCard
        .mockResolvedValueOnce([previous]); // currentCardRow
      db.returning.mockResolvedValue([{ ...previous }]);

      await updateCard(asDb(db), ctx, "card-1", {
        title: "Title",
        body: "Body",
        priority: "medium",
      });

      expect(dispatchEvent).toHaveBeenCalledWith(
        "org-1",
        "ws-1",
        "card.updated",
        expect.objectContaining({ changedFields: [] }),
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
        "card.updated",
        expect.objectContaining({ changedFields: ["body"] }),
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
        "card.updated",
        expect.objectContaining({ changedFields: ["body"] }),
      );
    });
  });

  describe("bulkUpdateCards", () => {
    it("reports the cards it could not reach and updates the rest", async () => {
      db.limit
        .mockResolvedValueOnce([
          { id: "card-1", columnId: "col-1", boardId: "board-1" },
        ])
        .mockResolvedValueOnce([]) // card-2 is out of scope
        .mockResolvedValueOnce([{ id: "card-1", priority: "low" }]); // card-1's row before this write
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
        "card.updated",
        expect.objectContaining({ changedFields: ["priority"] }),
      );
    });

    it("refuses the whole batch when the assignee cannot work here", async () => {
      db.where.mockResolvedValueOnce([]); // org member — none
      db.where.mockResolvedValueOnce([]); // super admin — none

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
        .mockResolvedValueOnce([{ id: "col-new", boardId: "board-1" }]) // requireColumn (target)
        .mockResolvedValueOnce([
          { id: "card-1", columnId: "col-old", boardId: "board-1" },
        ]) // requireCard card-1
        .mockResolvedValueOnce([
          { id: "card-2", columnId: "col-new", boardId: "board-1" },
        ]) // requireCard card-2, already in the target column
        .mockResolvedValueOnce([{ id: "card-1", columnId: "col-old" }]) // card-1's row before this write
        .mockResolvedValueOnce([{ id: "card-2", columnId: "col-new" }]); // card-2's row before this write
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
        "card.moved",
        expect.objectContaining({
          id: "card-1",
          previousColumnId: "col-old",
        }),
      );
      expect(dispatchEvent).not.toHaveBeenCalledWith(
        "org-1",
        "ws-1",
        "card.moved",
        expect.objectContaining({ id: "card-2" }),
      );
      expect(dispatchEvent).toHaveBeenCalledWith(
        "org-1",
        "ws-1",
        "card.updated",
        expect.objectContaining({ id: "card-1", changedFields: ["columnId"] }),
      );
      expect(dispatchEvent).toHaveBeenCalledWith(
        "org-1",
        "ws-1",
        "card.updated",
        expect.objectContaining({ id: "card-2", changedFields: [] }),
      );
    });
  });
});
