import { describe, it, expect, vi, beforeEach } from "vitest";
import type { z } from "zod";
import { callOkTool, callTool, resetMockDb, seedDb } from "../test-utils.ts";

vi.mock("../services/event-dispatch.ts", () => ({
  dispatchEvent: vi.fn(),
}));

import { createKanbanBoardTools } from "./kanban-boards.ts";

const workspaceId = "ws-1";
const orgId = "org-1";
const frontendUrl = "http://localhost:3000";
const boardUrl = (boardId: string) =>
  `${frontendUrl}/${orgId}/workspace/${workspaceId}/boards/${boardId}`;

describe("createKanbanBoardTools", () => {
  let tools: ReturnType<typeof createKanbanBoardTools>;

  beforeEach(() => {
    vi.clearAllMocks();
    resetMockDb();
    tools = createKanbanBoardTools(workspaceId, orgId, frontendUrl);
  });

  it("returns the expected tool names", () => {
    expect(Object.keys(tools)).toEqual([
      "listBoards",
      "getBoardState",
      "upsertBoard",
      "deleteBoard",
      "upsertColumn",
      "deleteColumn",
      "reorderColumns",
    ]);
  });

  /** A Board in this Workspace and one in another, over the fake db. */
  const seedBoards = () =>
    seedDb({
      kanban_board: [
        {
          id: "b1",
          workspaceId,
          name: "Roadmap",
          description: null,
          labels: [
            { id: "lbl-1", name: "Bug", color: "#ef4444" },
            { id: "lbl-2", name: "Idea", color: "#3b82f6" },
          ],
          createdAt: new Date("2026-01-01"),
          updatedAt: new Date("2026-01-01"),
        },
        {
          id: "b-other",
          workspaceId: "ws-2",
          name: "Theirs",
          description: null,
          labels: [],
          createdAt: new Date("2026-01-01"),
          updatedAt: new Date("2026-01-01"),
        },
      ],
      kanban_column: [
        { id: "col-1", boardId: "b1", name: "To Do", position: 1 },
        { id: "col-2", boardId: "b1", name: "Done", position: 2 },
        { id: "col-other", boardId: "b-other", name: "To Do", position: 1 },
      ],
      kanban_card: [
        {
          id: "card-1",
          columnId: "col-1",
          title: "First",
          position: 1,
          labelIds: ["lbl-1", "lbl-2"],
          assignees: [],
          priority: "none",
        },
      ],
    });

  describe("upsertBoard", () => {
    it("creates a board with the default columns and a link to it", async () => {
      const db = seedBoards();

      const board = (await callOkTool(tools.upsertBoard, {
        label: "Sprint",
        name: "Sprint",
        description: "This sprint",
        labels: [{ name: "Urgent", color: "#ef4444" }],
      })) as { id: string; url?: string };

      expect(board).toMatchObject({
        name: "Sprint",
        description: "This sprint",
        workspaceId,
        labels: [
          {
            id: expect.any(String) as unknown,
            name: "Urgent",
            color: "#ef4444",
          },
        ],
      });
      expect(board.url).toBe(boardUrl(board.id));
      expect(
        db.tables.kanban_column
          .filter((c) => c.boardId === board.id)
          .map((c) => c.name),
      ).toEqual(["To Do", "In Progress", "Done"]);
    });

    it("refuses to create without a name", async () => {
      expect(await callTool(tools.upsertBoard, { label: "x" })).toEqual({
        error: "name is required when creating a new board",
      });
    });

    it("renames and re-labels a board, pruning dropped labels off its cards", async () => {
      const db = seedBoards();

      expect(
        await callOkTool(tools.upsertBoard, {
          boardId: "b1",
          label: "Roadmap",
          name: "Roadmap 2027",
          labels: [{ id: "lbl-1", name: "Bug", color: "#ef4444" }],
        }),
      ).toMatchObject({
        id: "b1",
        name: "Roadmap 2027",
        labels: [{ id: "lbl-1", name: "Bug", color: "#ef4444" }],
        url: boardUrl("b1"),
      });
      expect(db.tables.kanban_card[0]).toMatchObject({ labelIds: ["lbl-1"] });
    });

    it("does not reach another Workspace's board", async () => {
      const db = seedBoards();

      expect(
        await callTool(tools.upsertBoard, {
          boardId: "b-other",
          label: "Theirs",
          name: "Mine now",
        }),
      ).toEqual({ error: "Board not found" });
      expect(db.tables.kanban_board[1]).toMatchObject({ name: "Theirs" });
    });

    it("refuses a label colour the routes would refuse", () => {
      // The AI SDK validates input against this schema before `execute` runs.
      const schema = tools.upsertBoard.inputSchema as z.ZodType;
      expect(
        schema.safeParse({
          label: "x",
          name: "Board",
          labels: [{ name: "Bug", color: "#000000" }],
        }).success,
      ).toBe(false);
    });
  });

  describe("deleteBoard", () => {
    it("refuses when confirmName does not match the board's name", async () => {
      const db = seedBoards();

      expect(
        await callTool(tools.deleteBoard, {
          boardId: "b1",
          label: "Roadmap",
          confirmName: "Roadmp",
        }),
      ).toEqual({
        error: expect.stringContaining("Roadmap") as unknown,
      });
      expect(db.tables.kanban_board.map((b) => b.id)).toContain("b1");
    });

    it("deletes the board when confirmName matches", async () => {
      const db = seedBoards();

      expect(
        await callTool(tools.deleteBoard, {
          boardId: "b1",
          label: "Roadmap",
          confirmName: "Roadmap",
        }),
      ).toEqual({ success: true });
      expect(db.tables.kanban_board.map((b) => b.id)).toEqual(["b-other"]);
    });

    it("does not reach another Workspace's board", async () => {
      const db = seedBoards();

      expect(
        await callTool(tools.deleteBoard, {
          boardId: "b-other",
          label: "Theirs",
          confirmName: "Theirs",
        }),
      ).toEqual({ error: "Board not found" });
      expect(db.tables.kanban_board).toHaveLength(2);
    });
  });

  describe("upsertColumn", () => {
    it("appends a new column to the end of the board", async () => {
      const db = seedBoards();

      expect(
        await callOkTool(tools.upsertColumn, {
          boardId: "b1",
          label: "Review",
          name: "Review",
        }),
      ).toMatchObject({ boardId: "b1", name: "Review", position: 3 });
      expect(db.tables.kanban_column).toHaveLength(4);
    });

    it("renames a column", async () => {
      seedBoards();

      expect(
        await callOkTool(tools.upsertColumn, {
          boardId: "b1",
          columnId: "col-2",
          label: "Shipped",
          name: "Shipped",
        }),
      ).toMatchObject({ id: "col-2", name: "Shipped" });
    });

    it("refuses a name another column on the board already has", async () => {
      seedBoards();

      expect(
        await callTool(tools.upsertColumn, {
          boardId: "b1",
          label: "Done",
          name: "Done",
        }),
      ).toEqual({ error: expect.any(String) as unknown });
    });

    it("does not reach another Workspace's board", async () => {
      const db = seedBoards();

      expect(
        await callTool(tools.upsertColumn, {
          boardId: "b-other",
          label: "x",
          name: "x",
        }),
      ).toEqual({ error: "Board not found" });
      expect(db.tables.kanban_column).toHaveLength(3);
    });
  });

  describe("deleteColumn", () => {
    it("deletes a column on the board", async () => {
      const db = seedBoards();

      expect(
        await callTool(tools.deleteColumn, {
          boardId: "b1",
          columnId: "col-2",
          label: "Done",
        }),
      ).toEqual({ success: true });
      expect(db.tables.kanban_column.map((c) => c.id)).toEqual([
        "col-1",
        "col-other",
      ]);
    });

    it("does not reach a column on another board", async () => {
      const db = seedBoards();

      expect(
        await callTool(tools.deleteColumn, {
          boardId: "b1",
          columnId: "col-other",
          label: "x",
        }),
      ).toEqual({ error: "Column not found" });
      expect(db.tables.kanban_column).toHaveLength(3);
    });
  });

  describe("reorderColumns", () => {
    it("puts the columns in the order given", async () => {
      const db = seedBoards();

      expect(
        await callTool(tools.reorderColumns, {
          boardId: "b1",
          columnIds: ["col-2", "col-1"],
          label: "Roadmap",
        }),
      ).toEqual({ success: true });
      expect(
        db.tables.kanban_column
          .filter((c) => c.boardId === "b1")
          .sort((a, b) => Number(a.position) - Number(b.position))
          .map((c) => c.id),
      ).toEqual(["col-2", "col-1"]);
    });

    it("refuses a column from another board", async () => {
      seedBoards();

      expect(
        await callTool(tools.reorderColumns, {
          boardId: "b1",
          columnIds: ["col-1", "col-other"],
          label: "Roadmap",
        }),
      ).toEqual({ error: "Some column IDs do not belong to this board" });
    });
  });
});
