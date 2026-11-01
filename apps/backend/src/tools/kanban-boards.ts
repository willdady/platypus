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
import { createBoardReadTools } from "./kanban.ts";
import { asToolResult } from "./tool-result.ts";

/**
 * The Agent-facing surface over board and column structure — the Kanban Boards
 * Tool set. As with `./kanban.ts`, the rules live in the modules the HTTP
 * routes share; the field limits come from the routes' own schemas.
 */
export function createKanbanBoardTools(
  workspaceId: string,
  orgId: string,
  frontendUrl: string,
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
    return { ...board, url };
  };

  const { listBoards, getBoardState } = createBoardReadTools(
    scope,
    frontendUrl,
  );

  /** The board fields a write may set, without the create-only `name`. */
  const boardFields = {
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
  };

  type BoardLabels = NonNullable<z.infer<typeof boardFields.labels>>;

  /** Board labels as the module stores them: an omitted id becomes a new one. */
  const withLabelIds = (labels: BoardLabels | undefined) =>
    labels?.map(({ id = nanoid(), ...l }) => ({ id, ...l }));

  const createBoardTool = tool({
    description:
      "Create a kanban board with To Do, In Progress and Done columns. Requires name; every other field is optional.",
    inputSchema: z.object({
      label: z.string().describe("The board name (for display purposes)"),
      name: kanbanBoardSchema.shape.name.describe("The board name"),
      ...boardFields,
    }),
    execute: async ({ name, label: _label, labels, ...fields }) =>
      asToolResult(async () =>
        withBoardUrl(
          await createBoard(db, scope, {
            ...fields,
            ...(labels && { labels: withLabelIds(labels) }),
            name,
          }),
        ),
      ),
  });

  const updateBoardTool = tool({
    description:
      "Update a kanban board. Only the fields provided are changed; setting labels replaces the board's labels, and cards lose any label dropped.",
    inputSchema: z.object({
      boardId: z.string().describe("The board ID to update"),
      label: z.string().describe("The board name (for display purposes)"),
      name: kanbanBoardSchema.shape.name.optional().describe("The new name"),
      ...boardFields,
    }),
    execute: async ({ boardId, name, label: _label, labels, ...fields }) =>
      asToolResult(async () =>
        withBoardUrl(
          await updateBoard(db, scope, boardId, {
            ...fields,
            ...(name !== undefined && { name }),
            ...(labels && { labels: withLabelIds(labels) }),
          }),
        ),
      ),
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

  const createColumnTool = tool({
    description: "Add a column to the end of a kanban board.",
    inputSchema: z.object({
      boardId: z.string().describe("The ID of the board the column is on"),
      label: z.string().describe("The column name (for display purposes)"),
      name: kanbanColumnSchema.shape.name.describe(
        "The column name, unique on its board",
      ),
    }),
    execute: async ({ boardId, name }) =>
      asToolResult(() => createColumn(db, scope, boardId, { name })),
  });

  const updateColumnTool = tool({
    description: "Rename a column on a kanban board.",
    inputSchema: z.object({
      boardId: z.string().describe("The ID of the board the column is on"),
      columnId: z.string().describe("The column ID to rename"),
      label: z.string().describe("The column name (for display purposes)"),
      name: kanbanColumnSchema.shape.name.describe(
        "The column's new name, unique on its board",
      ),
    }),
    execute: async ({ boardId, columnId, name }) =>
      asToolResult(() => renameColumn(db, scope, boardId, columnId, { name })),
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
    createBoard: createBoardTool,
    updateBoard: updateBoardTool,
    deleteBoard: deleteBoardTool,
    createColumn: createColumnTool,
    updateColumn: updateColumnTool,
    deleteColumn: deleteColumnTool,
    reorderColumns: reorderColumnsTool,
  };
}
