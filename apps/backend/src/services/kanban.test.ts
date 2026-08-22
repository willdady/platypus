import { describe, it, expect, vi, beforeEach } from "vitest";
import { asDb, createMockDb, type MockDb } from "../test-utils.ts";

vi.mock("./event-dispatch.ts", () => ({
  dispatchEvent: vi.fn(),
}));

import { NotFoundError, ValidationError } from "../errors.ts";
import { dispatchEvent } from "./event-dispatch.ts";
import {
  applyBodyDiff,
  bulkUpdateCards,
  keepKnownLabelIds,
  moveCard,
  placeCardInColumn,
  rebalancedPositions,
  requireCard,
  requireKnownLabelIds,
  requireValidAssignees,
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
        expect.anything(),
      );
      expect(dispatchEvent).toHaveBeenCalledWith(
        "org-1",
        "ws-1",
        "card.updated",
        expect.objectContaining({ id: "card-1", boardId: "board-1" }),
        expect.anything(),
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
        expect.anything(),
      );
      expect(dispatchEvent).toHaveBeenCalledWith(
        "org-1",
        "ws-1",
        "card.updated",
        expect.objectContaining({ id: "card-1", boardId: "board-1" }),
        expect.anything(),
      );
    });
  });

  describe("bulkUpdateCards", () => {
    it("reports the cards it could not reach and updates the rest", async () => {
      db.limit
        .mockResolvedValueOnce([
          { id: "card-1", columnId: "col-1", boardId: "board-1" },
        ])
        .mockResolvedValueOnce([]); // card-2 is out of scope
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
        ]); // requireCard card-2, already in the target column
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
        expect.anything(),
      );
      expect(dispatchEvent).not.toHaveBeenCalledWith(
        "org-1",
        "ws-1",
        "card.moved",
        expect.objectContaining({ id: "card-2" }),
        expect.anything(),
      );
      expect(dispatchEvent).toHaveBeenCalledWith(
        "org-1",
        "ws-1",
        "card.updated",
        expect.objectContaining({ id: "card-1" }),
        expect.anything(),
      );
      expect(dispatchEvent).toHaveBeenCalledWith(
        "org-1",
        "ws-1",
        "card.updated",
        expect.objectContaining({ id: "card-2" }),
        expect.anything(),
      );
    });
  });
});
