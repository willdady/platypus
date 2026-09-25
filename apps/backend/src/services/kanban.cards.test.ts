import { describe, it, expect, vi, beforeEach } from "vitest";
import { resetMockDb, seedDb, type FakeDb, type Row } from "../test-utils.ts";

vi.mock("./event-dispatch.ts", () => ({
  dispatchEvent: vi.fn(),
}));

import { db } from "../index.ts";
import { NotFoundError } from "../errors.ts";
import { dispatchEvent } from "./event-dispatch.ts";
import {
  bulkUpdateCards,
  deleteCards,
  requireCard,
  type KanbanContext,
} from "./kanban.ts";

type Database = typeof db;

/**
 * Batch Card writes over the seeded fake, which evaluates each query's joins
 * and `WHERE`: `kanban.test.ts` stubs `requireCard` positionally, so it cannot
 * show which Workspace's Card a batch actually reached. Two Workspaces each hold
 * a Board, a Column and Cards; every batch names at least one of the other's.
 */

const ctx: KanbanContext = {
  orgId: "org-1",
  workspaceId: "ws-1",
  actor: { agentId: "agent-1" },
};

const card = (id: string, columnId: string, extra: Row = {}): Row => ({
  id,
  columnId,
  title: id,
  body: null,
  position: 1,
  labelIds: [],
  assignees: [],
  priority: null,
  dueDate: null,
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
  ...extra,
});

const seed = () => {
  const fake = seedDb({
    kanban_board: [
      {
        id: "board-a",
        workspaceId: "ws-1",
        labels: [
          { id: "lbl-1", name: "One", color: "#000" },
          { id: "lbl-2", name: "Two", color: "#111" },
        ],
      },
      { id: "board-b", workspaceId: "ws-2", labels: [] },
    ],
    kanban_column: [
      { id: "col-a1", boardId: "board-a", name: "To Do", position: 1 },
      { id: "col-a2", boardId: "board-a", name: "Done", position: 2 },
      { id: "col-b", boardId: "board-b", name: "To Do", position: 1 },
    ],
    kanban_card: [
      card("card-1", "col-a1", { labelIds: ["lbl-1"] }),
      card("card-2", "col-a1", { labelIds: ["lbl-2", "lbl-stale"] }),
      card("card-theirs", "col-b", { labelIds: ["lbl-x"] }),
    ],
  });
  return { fake, database: fake.handle as Database };
};

const cardIn = (fake: FakeDb, id: string) =>
  fake.tables.kanban_card.find((row) => row.id === id);

describe("kanban module — batch Card writes", () => {
  beforeEach(() => {
    resetMockDb();
    vi.mocked(dispatchEvent).mockClear();
  });

  describe("requireCard", () => {
    it("returns this Workspace's card with the board it sits on", async () => {
      const { database } = seed();
      await expect(requireCard(database, ctx, "card-1")).resolves.toEqual({
        id: "card-1",
        columnId: "col-a1",
        boardId: "board-a",
      });
    });

    it.each([
      ["another Workspace's card", ctx, "card-theirs"],
      [
        "a card on another board than the one scoped to",
        { ...ctx, boardId: "board-z" },
        "card-1",
      ],
      ["a missing card", ctx, "gone"],
    ])("rejects %s", async (_label, scope, id) => {
      const { database } = seed();
      await expect(requireCard(database, scope, id)).rejects.toThrow(
        new NotFoundError("Card not found"),
      );
    });
  });

  describe("deleteCards", () => {
    it("deletes every named card in this Workspace, announcing each", async () => {
      const { fake, database } = seed();

      await deleteCards(database, ctx, ["card-1", "card-2"]);

      expect(fake.tables.kanban_card.map((row) => row.id)).toEqual([
        "card-theirs",
      ]);
      expect(dispatchEvent).toHaveBeenCalledTimes(2);
    });

    it("deletes none of a batch that names another Workspace's card, naming it", async () => {
      const { fake, database } = seed();

      await expect(
        deleteCards(database, ctx, ["card-1", "card-theirs"]),
      ).rejects.toThrow(new NotFoundError("Card not found: card-theirs"));

      expect(fake.tables.kanban_card).toHaveLength(3);
      expect(dispatchEvent).not.toHaveBeenCalled();
    });
  });

  describe("bulkUpdateCards", () => {
    it("reports another Workspace's card per card and leaves it untouched", async () => {
      const { fake, database } = seed();

      const outcomes = await bulkUpdateCards(database, ctx, {
        cardIds: ["card-theirs", "card-1"],
        priority: "high",
      });

      expect(outcomes).toEqual([
        { cardId: "card-theirs", success: false, error: "Card not found" },
        { cardId: "card-1", success: true },
      ]);
      expect(cardIn(fake, "card-1")?.priority).toBe("high");
      expect(cardIn(fake, "card-theirs")?.priority).toBeNull();
    });

    it("writes nothing when no named card is in this Workspace", async () => {
      const { fake, database } = seed();
      const before = structuredClone(fake.tables);

      const outcomes = await bulkUpdateCards(database, ctx, {
        cardIds: ["card-theirs", "gone"],
        priority: "high",
      });

      expect(outcomes.map((o) => o.success)).toEqual([false, false]);
      expect(fake.tables).toEqual(before);
      expect(dispatchEvent).not.toHaveBeenCalled();
    });

    it("refuses the whole batch when the target column is in another Workspace", async () => {
      const { fake, database } = seed();
      const before = structuredClone(fake.tables);

      await expect(
        bulkUpdateCards(database, ctx, {
          cardIds: ["card-1"],
          columnId: "col-b",
        }),
      ).rejects.toThrow(new NotFoundError("Column not found"));
      expect(fake.tables).toEqual(before);
    });

    it("appends moved cards to the target column in the order given", async () => {
      const { fake, database } = seed();
      cardIn(fake, "card-1")!.columnId = "col-a2";
      cardIn(fake, "card-1")!.position = 5;

      await bulkUpdateCards(database, ctx, {
        cardIds: ["card-2", "card-1"],
        columnId: "col-a2",
      });

      // After the column's current last position (5), in batch order.
      expect(cardIn(fake, "card-2")).toMatchObject({
        columnId: "col-a2",
        position: 6,
      });
      expect(cardIn(fake, "card-1")).toMatchObject({ position: 7 });
    });

    it("adds and removes labels on top of each card's own, dropping ones the board lacks", async () => {
      const { fake, database } = seed();

      await bulkUpdateCards(database, ctx, {
        cardIds: ["card-1", "card-2"],
        addLabelIds: ["lbl-2", "lbl-unknown"],
        removeLabelIds: ["lbl-1"],
      });

      expect(cardIn(fake, "card-1")?.labelIds).toEqual(["lbl-2"]);
      // The stale id the card already carried is healed away too.
      expect(cardIn(fake, "card-2")?.labelIds).toEqual(["lbl-2"]);
    });

    it("replaces labels outright when given a full set", async () => {
      const { fake, database } = seed();

      await bulkUpdateCards(database, ctx, {
        cardIds: ["card-1"],
        labelIds: ["lbl-2", "lbl-1"],
      });

      expect(cardIn(fake, "card-1")?.labelIds).toEqual(["lbl-2", "lbl-1"]);
    });
  });
});
