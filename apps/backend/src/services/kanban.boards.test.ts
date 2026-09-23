import { describe, it, expect, vi, beforeEach } from "vitest";
import { resetMockDb, seedDb, type FakeDb, type Store } from "../test-utils.ts";

vi.mock("./event-dispatch.ts", () => ({
  dispatchEvent: vi.fn(),
}));

import { db } from "../index.ts";
import { ConflictError, NotFoundError, ValidationError } from "../errors.ts";
import {
  createBoard,
  createColumn,
  deleteBoard,
  deleteColumn,
  getBoardState,
  listBoards,
  renameColumn,
  reorderColumns,
  resolveBoardState,
  updateBoard,
  type KanbanScope,
} from "./kanban.ts";

type Database = typeof db;

/**
 * Board and Column reads and writes through the module's interface, over the
 * seeded fake that interprets each query's `WHERE`. Every scope test stands up
 * two Workspaces, each with a Board and a Column, and aims at the one the
 * caller does not own: a write that forgot its scope reaches the other row and
 * the live `tables` show it.
 */

const scope: KanbanScope = { orgId: "org-1", workspaceId: "ws-1" };

const at = (iso: string) => new Date(iso);

const world = (extra: Store = {}): Store => ({
  workspace: [
    { id: "ws-1", organizationId: "org-1" },
    { id: "ws-2", organizationId: "org-1" },
  ],
  kanban_board: [
    {
      id: "board-a",
      workspaceId: "ws-1",
      name: "Mine",
      labels: [
        { id: "lbl-keep", name: "Keep", color: "#000" },
        { id: "lbl-drop", name: "Drop", color: "#fff" },
      ],
      createdAt: at("2026-01-01"),
    },
    {
      id: "board-b",
      workspaceId: "ws-2",
      name: "Theirs",
      labels: [{ id: "lbl-drop", name: "Drop", color: "#fff" }],
      createdAt: at("2026-01-02"),
    },
  ],
  kanban_column: [
    { id: "col-a1", boardId: "board-a", name: "To Do", position: 1 },
    { id: "col-a2", boardId: "board-a", name: "Done", position: 2 },
    { id: "col-b", boardId: "board-b", name: "To Do", position: 1 },
  ],
  ...extra,
});

/** Seeds the fake and hands back it plus the handle to pass as `database`. */
const seed = (rows: Store = world(), options = {}) => {
  const fake = seedDb(rows, options);
  return { fake, database: fake.handle as Database };
};

/** A deep copy of every table, to assert a refused write changed nothing. */
const snapshot = (fake: FakeDb) => structuredClone(fake.tables);

describe("kanban module — Boards and Columns", () => {
  beforeEach(() => {
    resetMockDb();
  });

  describe("scope", () => {
    const foreignWrites: [string, (database: Database) => Promise<unknown>][] =
      [
        [
          "update a Board",
          (d) => updateBoard(d, scope, "board-b", { name: "X" }),
        ],
        ["delete a Board", (d) => deleteBoard(d, scope, "board-b")],
        [
          "create a Column",
          (d) => createColumn(d, scope, "board-b", { name: "New" }),
        ],
        [
          "rename a Column",
          (d) => renameColumn(d, scope, "board-b", "col-b", { name: "X" }),
        ],
        ["delete a Column", (d) => deleteColumn(d, scope, "board-b", "col-b")],
        [
          "reorder Columns",
          (d) => reorderColumns(d, scope, "board-b", ["col-b"]),
        ],
        ["read Board state", (d) => getBoardState(d, scope, "board-b")],
      ];

    it.each(foreignWrites)(
      "refuses to %s in another Workspace, changing nothing",
      async (_name, write) => {
        const { fake, database } = seed();
        const before = snapshot(fake);

        await expect(write(database)).rejects.toThrow(NotFoundError);
        expect(fake.tables).toEqual(before);
      },
    );

    // The route addresses a Column through its Board's URL, so a Column on a
    // different Board of the same Workspace is not found there either.
    it.each([
      [
        "rename",
        (d: Database) =>
          renameColumn(d, scope, "board-a", "col-b", { name: "X" }),
      ],
      ["delete", (d: Database) => deleteColumn(d, scope, "board-a", "col-b")],
    ])(
      "refuses to %s a Column named under a Board it is not on",
      async (_name, write) => {
        const { fake, database } = seed();
        const before = snapshot(fake);

        await expect(write(database)).rejects.toThrow("Column not found");
        expect(fake.tables).toEqual(before);
      },
    );
  });

  describe("listBoards", () => {
    it("lists this Workspace's Boards, newest first", async () => {
      const { database } = seed(
        world({
          kanban_board: [
            ...world().kanban_board,
            {
              id: "board-c",
              workspaceId: "ws-1",
              name: "Newer",
              labels: [],
              createdAt: at("2026-03-01"),
            },
          ],
        }),
      );

      const boards = await listBoards(database, scope);
      expect(boards.map((b) => b.id)).toEqual(["board-c", "board-a"]);
    });
  });

  describe("createBoard", () => {
    it("writes the Board and its three default Columns", async () => {
      const { fake, database } = seed();

      const board = await createBoard(database, scope, { name: "Fresh" });

      expect(board).toMatchObject({ name: "Fresh", workspaceId: "ws-1" });
      expect(fake.tables.kanban_board).toContainEqual(
        expect.objectContaining({ id: board.id, name: "Fresh" }),
      );
      const columns = fake.tables.kanban_column
        .filter((col) => col.boardId === board.id)
        .map((col) => [col.name, col.position]);
      expect(columns).toEqual([
        ["To Do", 1],
        ["In Progress", 2],
        ["Done", 3],
      ]);
    });

    it("leaves no Board behind when its Columns fail to write", async () => {
      const { fake, database } = seed(world(), {
        onInsert: (table: string) => {
          if (table === "kanban_column") throw new Error("disk full");
        },
      });

      await expect(
        createBoard(database, scope, { name: "Doomed" }),
      ).rejects.toThrow("disk full");
      expect(fake.tables.kanban_board.map((b) => b.name)).toEqual([
        "Mine",
        "Theirs",
      ]);
    });
  });

  describe("updateBoard", () => {
    const cards: Store = {
      kanban_card: [
        {
          id: "card-a",
          columnId: "col-a1",
          labelIds: ["lbl-keep", "lbl-drop"],
        },
        // Another Board, carrying the same Label id — it must be left alone.
        { id: "card-b", columnId: "col-b", labelIds: ["lbl-drop"] },
      ],
    };

    it("strips a dropped Label from Cards on that Board only", async () => {
      const { fake, database } = seed(world(cards));

      const board = await updateBoard(database, scope, "board-a", {
        name: "Mine",
        labels: [{ id: "lbl-keep", name: "Keep", color: "#000" }],
      });

      expect(board.labels).toEqual([
        { id: "lbl-keep", name: "Keep", color: "#000" },
      ]);
      const labelsOf = (id: string) =>
        fake.tables.kanban_card.find((card) => card.id === id)?.labelIds;
      expect(labelsOf("card-a")).toEqual(["lbl-keep"]);
      expect(labelsOf("card-b")).toEqual(["lbl-drop"]);
    });

    it("leaves Card Labels alone when the update names no labels", async () => {
      const { fake, database } = seed(world(cards));

      await updateBoard(database, scope, "board-a", { name: "Renamed" });

      expect(fake.tables.kanban_card[0].labelIds).toEqual([
        "lbl-keep",
        "lbl-drop",
      ]);
    });

    // ADR-0024: a Board-level Label prune is not a Card field write.
    it("writes no Card history when pruning Labels", async () => {
      const { fake, database } = seed(world(cards));

      await updateBoard(database, scope, "board-a", {
        name: "Mine",
        labels: [],
      });

      expect(fake.tables.kanban_card_history ?? []).toEqual([]);
    });
  });

  describe("deleteBoard", () => {
    it("deletes a Board in this Workspace", async () => {
      const { fake, database } = seed();

      await deleteBoard(database, scope, "board-a");

      expect(fake.tables.kanban_board.map((b) => b.id)).toEqual(["board-b"]);
    });
  });

  describe("createColumn", () => {
    it("appends after the current highest position", async () => {
      const { fake, database } = seed();

      const column = await createColumn(database, scope, "board-a", {
        name: "Review",
      });

      expect(column).toMatchObject({
        boardId: "board-a",
        name: "Review",
        position: 3,
      });
      expect(fake.tables.kanban_column).toHaveLength(4);
    });

    it("starts at position 1 on a Board with no Columns", async () => {
      const { database } = seed(
        world({
          kanban_column: [
            { id: "col-b", boardId: "board-b", name: "To Do", position: 9 },
          ],
        }),
      );

      const column = await createColumn(database, scope, "board-a", {
        name: "First",
      });

      expect(column.position).toBe(1);
    });

    it("refuses a name the Board already has", async () => {
      const { fake, database } = seed();

      await expect(
        createColumn(database, scope, "board-a", { name: "Done" }),
      ).rejects.toThrow(
        new ConflictError(
          "A column with this name already exists on the board",
        ),
      );
      expect(fake.tables.kanban_column).toHaveLength(3);
    });

    it("accepts a name another Board uses", async () => {
      const { database } = seed(
        world({
          kanban_column: [
            { id: "col-b", boardId: "board-b", name: "Backlog", position: 1 },
          ],
        }),
      );

      await expect(
        createColumn(database, scope, "board-a", { name: "Backlog" }),
      ).resolves.toMatchObject({ name: "Backlog" });
    });
  });

  describe("renameColumn", () => {
    it("renames the Column", async () => {
      const { fake, database } = seed();

      const column = await renameColumn(database, scope, "board-a", "col-a1", {
        name: "Backlog",
      });

      expect(column).toMatchObject({ id: "col-a1", name: "Backlog" });
      expect(fake.tables.kanban_column[0].name).toBe("Backlog");
    });

    it("refuses a name another Column on the Board has", async () => {
      const { database } = seed();

      await expect(
        renameColumn(database, scope, "board-a", "col-a1", { name: "Done" }),
      ).rejects.toThrow(ConflictError);
    });

    it("accepts the Column's own name", async () => {
      const { database } = seed();

      await expect(
        renameColumn(database, scope, "board-a", "col-a1", { name: "To Do" }),
      ).resolves.toMatchObject({ id: "col-a1", name: "To Do" });
    });
  });

  describe("deleteColumn", () => {
    it("deletes the Column", async () => {
      const { fake, database } = seed();

      await deleteColumn(database, scope, "board-a", "col-a1");

      expect(fake.tables.kanban_column.map((col) => col.id)).toEqual([
        "col-a2",
        "col-b",
      ]);
    });
  });

  describe("reorderColumns", () => {
    it("writes positions 1..n in the order given", async () => {
      const { fake, database } = seed();

      await reorderColumns(database, scope, "board-a", ["col-a2", "col-a1"]);

      const positionOf = (id: string) =>
        fake.tables.kanban_column.find((col) => col.id === id)?.position;
      expect(positionOf("col-a2")).toBe(1);
      expect(positionOf("col-a1")).toBe(2);
      expect(positionOf("col-b")).toBe(1);
    });

    it("refuses an id that is not on the Board, changing nothing", async () => {
      const { fake, database } = seed();
      const before = snapshot(fake);

      await expect(
        reorderColumns(database, scope, "board-a", ["col-a1", "col-b"]),
      ).rejects.toThrow(
        new ValidationError("Some column IDs do not belong to this board"),
      );
      expect(fake.tables).toEqual(before);
    });
  });

  describe("Board state", () => {
    const rows = () =>
      world({
        kanban_column: [
          { id: "col-a2", boardId: "board-a", name: "Done", position: 2 },
          { id: "col-b", boardId: "board-b", name: "To Do", position: 1 },
          { id: "col-a1", boardId: "board-a", name: "To Do", position: 1 },
        ],
        kanban_card: [
          {
            id: "card-2",
            columnId: "col-a1",
            title: "Second",
            position: 2,
            labelIds: [],
            assignees: [{ type: "agent", id: "agent-1" }],
            dueDate: at("2026-05-01T00:00:00.000Z"),
            createdByUserId: null,
            createdByAgentId: "agent-1",
            lastEditedByUserId: "user-1",
            lastEditedByAgentId: null,
          },
          {
            id: "card-1",
            columnId: "col-a1",
            title: "First",
            position: 1,
            labelIds: [],
            assignees: [
              { type: "user", id: "user-1" },
              { type: "user", id: "user-gone" },
            ],
            dueDate: null,
            createdByUserId: "user-1",
            createdByAgentId: null,
            lastEditedByUserId: null,
            lastEditedByAgentId: null,
          },
          {
            id: "card-3",
            columnId: "col-a2",
            title: "Third",
            position: 1,
            labelIds: [],
            assignees: [],
            dueDate: null,
            createdByUserId: null,
            createdByAgentId: null,
            lastEditedByUserId: null,
            lastEditedByAgentId: null,
          },
          {
            id: "card-b",
            columnId: "col-b",
            title: "Theirs",
            position: 1,
            labelIds: [],
            assignees: [],
            dueDate: null,
          },
        ],
        kanban_card_comment: [
          { id: "m1", cardId: "card-1" },
          { id: "m2", cardId: "card-1" },
          { id: "m3", cardId: "card-b" },
        ],
        user: [{ id: "user-1", name: "Ada", image: "https://img/ada.png" }],
        agent: [{ id: "agent-1", name: "Bot", avatarKey: null }],
      });

    it("orders Columns by position, and Cards by position within each", async () => {
      const { database } = seed(rows());

      const state = await getBoardState(database, scope, "board-a");

      expect(state.board.id).toBe("board-a");
      expect(
        state.columns.map((col) => [col.id, col.cards.map((c) => c.id)]),
      ).toEqual([
        ["col-a1", ["card-1", "card-2"]],
        ["col-a2", ["card-3"]],
      ]);
    });

    it("resolves names, assignees and comment counts, from this Board only", async () => {
      const { database } = seed(rows());

      const state = await resolveBoardState(
        database,
        await getBoardState(database, scope, "board-a"),
        "http://api.test",
      );

      const [first, second] = state.columns[0].cards;
      expect(first).toMatchObject({
        id: "card-1",
        createdByName: "Ada",
        lastEditedByName: null,
        // An assignee who no longer resolves is left out.
        resolvedAssignees: [
          {
            type: "user",
            id: "user-1",
            name: "Ada",
            image: "https://img/ada.png",
          },
        ],
        commentCount: 2,
        dueDate: null,
      });
      expect(second).toMatchObject({
        id: "card-2",
        createdByName: "Bot",
        lastEditedByName: "Ada",
        resolvedAssignees: [
          { type: "agent", id: "agent-1", name: "Bot", image: null },
        ],
        commentCount: 0,
        dueDate: "2026-05-01T00:00:00.000Z",
      });
      expect(
        state.columns.flatMap((col) => col.cards.map((card) => card.id)),
      ).not.toContain("card-b");
    });
  });
});
