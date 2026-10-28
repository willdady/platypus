import { tool, type Tool } from "ai";
import { z } from "zod";
import { nanoid } from "nanoid";
import {
  kanbanBoardSchema,
  kanbanColumnSchema,
  kanbanLabelSchema,
} from "@platypus/schemas";
import { db } from "../index.ts";
import {
  createBoard,
  deleteBoard,
  updateBoard,
} from "../services/kanban-board.ts";
import {
  createColumn,
  deleteColumn,
  renameColumn,
  reorderColumns,
} from "../services/kanban-column.ts";
import {
  requireBoard,
  type BoardRow,
  type KanbanScope,
} from "../services/kanban-shared.ts";
import { buildResourceUrl } from "../utils/resource-url.ts";
import { asToolResult, createBoardReadTools } from "./kanban.ts";

/**
 * The Agent-facing surface over board and column structure — the Kanban Boards
 * Tool set. As with `./kanban.ts`, the rules live in the modules the HTTP
 * routes share; the field limits come from the routes' own schemas.
 */
export function createKanbanBoardTools(
  workspaceId: string,
  orgId: string,
  frontendUrl: string | undefined,
): Record<string, Tool> {
  const scope: KanbanScope = { orgId, workspaceId };

  /** A written board as a Tool returns it: the row, plus a link to it. */
  const withBoardUrl = (board: BoardRow) => {
    const url = buildResourceUrl(
      frontendUrl,
      orgId,
      workspaceId,
      `boards/${board.id}`,
    );
    return { ...board, ...(url && { url }) };
  };

  const { listBoards, getBoardState } = createBoardReadTools(
    scope,
    frontendUrl,
  );

  const upsertBoard = tool({
    description:
      "Create a new kanban board or update an existing one. If boardId is provided, updates that board; otherwise creates a new board (requires name) with To Do, In Progress and Done columns. Setting labels replaces the board's labels; cards lose any label dropped.",
    inputSchema: z.object({
      boardId: z
        .string()
        .optional()
        .describe(
          "The board ID to update. If not provided, a new board will be created.",
        ),
      label: z.string().describe("The board name (for display purposes)"),
      name: kanbanBoardSchema.shape.name
        .optional()
        .describe("The board name (required when creating a new board)"),
      description: kanbanBoardSchema.shape.description.describe(
        "The board description, or null to clear it",
      ),
      labels: z
        .array(
          kanbanLabelSchema.extend({
            id: z
              .string()
              .optional()
              .describe(
                "Keep an existing label's ID to keep it on its cards; omit for a new label",
              ),
          }),
        )
        .optional()
        .describe(
          "The board's full set of labels, replacing the current set. Omit to leave labels unchanged.",
        ),
    }),
    execute: async ({ boardId, name, label: _label, labels, ...fields }) =>
      asToolResult(async () => {
        const input = {
          ...fields,
          ...(name !== undefined && { name }),
          ...(labels && {
            labels: labels.map(({ id = nanoid(), ...l }) => ({ id, ...l })),
          }),
        };

        if (boardId) {
          return withBoardUrl(await updateBoard(db, scope, boardId, input));
        }

        if (name === undefined) {
          return { error: "name is required when creating a new board" };
        }

        return withBoardUrl(await createBoard(db, scope, { ...input, name }));
      }),
  });

  const deleteBoardTool = tool({
    description:
      "Permanently delete a kanban board with all of its columns, cards and comments. Cannot be undone. Requires the board's current name in confirmName.",
    inputSchema: z.object({
      boardId: z.string().describe("The ID of the board to delete"),
      label: z.string().describe("The board name (for display purposes)"),
      confirmName: z
        .string()
        .describe(
          "The board's current name, exactly as getBoardState or listBoards returns it. The delete is refused on a mismatch.",
        ),
    }),
    execute: async ({ boardId, confirmName }) =>
      asToolResult(async () => {
        // A misread id must not take a board full of cards with it.
        const board = await requireBoard(db, scope, boardId);
        if (board.name !== confirmName) {
          return {
            error: `confirmName does not match the board's name "${board.name}"; nothing was deleted`,
          };
        }

        await deleteBoard(db, scope, boardId);
        return { success: true };
      }),
  });

  const upsertColumn = tool({
    description:
      "Add a column to a kanban board or rename one. If columnId is provided, renames that column; otherwise adds a new column to the end of the board.",
    inputSchema: z.object({
      boardId: z.string().describe("The ID of the board the column is on"),
      columnId: z
        .string()
        .optional()
        .describe(
          "The column ID to rename. If not provided, a new column will be added.",
        ),
      label: z.string().describe("The column name (for display purposes)"),
      name: kanbanColumnSchema.shape.name.describe(
        "The column name, unique on its board",
      ),
    }),
    execute: async ({ boardId, columnId, name }) =>
      asToolResult(() =>
        columnId
          ? renameColumn(db, scope, boardId, columnId, { name })
          : createColumn(db, scope, boardId, { name }),
      ),
  });

  const deleteColumnTool = tool({
    description:
      "Permanently delete a column from a kanban board, along with every card in it. Move cards out first to keep them.",
    inputSchema: z.object({
      boardId: z.string().describe("The ID of the board the column is on"),
      columnId: z.string().describe("The ID of the column to delete"),
      label: z.string().describe("The column name (for display purposes)"),
    }),
    execute: async ({ boardId, columnId }) =>
      asToolResult(async () => {
        await deleteColumn(db, scope, boardId, columnId);
        return { success: true };
      }),
  });

  const reorderColumnsTool = tool({
    description:
      "Reorder the columns of a kanban board. Pass every column ID on the board, from getBoardState, in the new left-to-right order.",
    inputSchema: z.object({
      boardId: z.string().describe("The ID of the board"),
      columnIds: z
        .array(z.string())
        .min(1)
        .describe("The board's column IDs in their new order"),
      label: z.string().describe("The board name (for display purposes)"),
    }),
    execute: async ({ boardId, columnIds }) =>
      asToolResult(async () => {
        await reorderColumns(db, scope, boardId, columnIds);
        return { success: true };
      }),
  });

  return {
    listBoards,
    getBoardState,
    upsertBoard,
    deleteBoard: deleteBoardTool,
    upsertColumn,
    deleteColumn: deleteColumnTool,
    reorderColumns: reorderColumnsTool,
  };
}
