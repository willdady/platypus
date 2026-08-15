import { tool, type Tool } from "ai";
import { z } from "zod";
import { asc, eq, inArray } from "drizzle-orm";
import { db } from "../index.ts";
import {
  kanbanBoard as kanbanBoardTable,
  kanbanColumn as kanbanColumnTable,
  kanbanCard as kanbanCardTable,
} from "../db/schema.ts";
import { NotFoundError, ValidationError } from "../errors.ts";
import {
  bulkUpdateCards,
  copyCard,
  createCard,
  createComment,
  deleteCards,
  listComments,
  moveCard,
  requireBoard,
  requireCard,
  removeComment,
  requireComment,
  resolveCommentNames,
  updateCard,
  updateCommentBody,
  type KanbanContext,
} from "../services/kanban.ts";
import { buildResourceUrl } from "../utils/resource-url.ts";
import { createListAgentsTool } from "./agent-discovery.ts";

/**
 * The Agent-facing surface over the Kanban module (`services/kanban.ts`): each
 * Tool parses its input, calls the module, and shapes the result. The board's
 * rules — what a label may be, who may be assigned, where a card lands, what
 * event fires — belong to the module and are shared with the HTTP routes, so
 * an Agent cannot write anything a person could not write through the UI.
 */
export function createKanbanTools(
  workspaceId: string,
  agentId: string,
  orgId: string,
  frontendUrl: string | undefined,
): Record<string, Tool> {
  // No board is named: an Agent works across every board in its Workspace.
  const ctx: KanbanContext = {
    orgId,
    workspaceId,
    actor: { agentId },
  };

  /**
   * Turns the module's typed failures into the `{ error }` payload a Tool
   * result carries — a Tool reports a problem back to the model rather than
   * throwing it into the run.
   */
  async function asToolResult<T>(
    run: () => Promise<T>,
  ): Promise<T | ErrorResult> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof NotFoundError || error instanceof ValidationError) {
        return { error: error.message };
      }
      throw error;
    }
  }

  /** The board's page in the frontend, when one is configured. */
  const boardUrl = (boardId: string): string | undefined =>
    buildResourceUrl(frontendUrl, orgId, workspaceId, `boards/${boardId}`);

  /** A deep link that opens the card on its board. */
  const cardUrl = (boardId: string, cardId: string): string | undefined => {
    const url = boardUrl(boardId);
    return url && `${url}?cardId=${cardId}`;
  };

  /** A written card as a Tool returns it: the row, plus a link to it. */
  const withCardUrl = <T extends { id: string }>(result: {
    card: T;
    boardId: string;
  }) => {
    const url = cardUrl(result.boardId, result.card.id);
    return { ...result.card, ...(url && { url }) };
  };

  const listAgents = createListAgentsTool({ orgId, workspaceId });

  const listBoards = tool({
    description: "List all kanban boards in the current workspace.",
    inputSchema: z.object({}),
    execute: async () => {
      const boards = await db
        .select({
          id: kanbanBoardTable.id,
          name: kanbanBoardTable.name,
          description: kanbanBoardTable.description,
          labels: kanbanBoardTable.labels,
          createdAt: kanbanBoardTable.createdAt,
        })
        .from(kanbanBoardTable)
        .where(eq(kanbanBoardTable.workspaceId, workspaceId));
      return boards;
    },
  });

  const getBoardState = tool({
    description:
      "Get the state of a kanban board including columns with nested card summaries (id, title, position, labelIds) and labels. Use getCard to fetch full card details.",
    inputSchema: z.object({
      boardId: z.string().describe("The ID of the board to get state for"),
      label: z.string().describe("The board name (for display purposes)"),
    }),
    execute: async ({ boardId }) =>
      asToolResult(async () => {
        const board = await requireBoard(db, ctx, boardId);

        const columns = await db
          .select()
          .from(kanbanColumnTable)
          .where(eq(kanbanColumnTable.boardId, boardId))
          .orderBy(asc(kanbanColumnTable.position));

        const columnIds = columns.map((col) => col.id);

        type CardSummary = {
          id: string;
          columnId: string;
          title: string;
          position: number;
          labelIds: string[];
          assignees: { type: "user" | "agent"; id: string }[];
          dueDate: Date | null;
          priority: string;
        };

        let cards: CardSummary[] = [];
        if (columnIds.length > 0) {
          cards = await db
            .select({
              id: kanbanCardTable.id,
              columnId: kanbanCardTable.columnId,
              title: kanbanCardTable.title,
              position: kanbanCardTable.position,
              labelIds: kanbanCardTable.labelIds,
              assignees: kanbanCardTable.assignees,
              dueDate: kanbanCardTable.dueDate,
              priority: kanbanCardTable.priority,
            })
            .from(kanbanCardTable)
            .where(inArray(kanbanCardTable.columnId, columnIds))
            .orderBy(asc(kanbanCardTable.position));
        }

        const cardsByColumn = new Map<string, CardSummary[]>();
        for (const card of cards) {
          const existing = cardsByColumn.get(card.columnId) ?? [];
          existing.push(card);
          cardsByColumn.set(card.columnId, existing);
        }

        const columnsWithCards = columns.map((col) => ({
          ...col,
          cards: cardsByColumn.get(col.id) ?? [],
        }));

        const url = boardUrl(boardId);

        return {
          board,
          columns: columnsWithCards,
          labels: board.labels,
          ...(url && { url }),
        };
      }),
  });

  const getCard = tool({
    description: "Get full details of a specific kanban card.",
    inputSchema: z.object({
      cardId: z.string().describe("The ID of the card to get"),
      label: z.string().describe("The card title (for display purposes)"),
    }),
    execute: async ({ cardId }) =>
      asToolResult(async () => {
        const ref = await requireCard(db, ctx, cardId);

        const cards = await db
          .select()
          .from(kanbanCardTable)
          .where(eq(kanbanCardTable.id, cardId))
          .limit(1);

        return withCardUrl({ card: cards[0], boardId: ref.boardId });
      }),
  });

  const upsertCard = tool({
    description:
      "Create a new card or update an existing card. If cardId is provided, updates the existing card. If cardId is not provided, creates a new card (requires columnId and title).",
    inputSchema: z
      .object({
        cardId: z
          .string()
          .optional()
          .describe(
            "The card ID to update. If not provided, a new card will be created.",
          ),
        label: z
          .string()
          .describe(
            "The card title for display purposes (required when updating by cardId)",
          ),
        columnId: z
          .string()
          .optional()
          .describe("The column ID (required when creating a new card)"),
        title: z
          .string()
          .optional()
          .describe("The card title (required when creating a new card)"),
        body: z.string().optional().describe("The card body/description"),
        bodyDiff: z
          .union([
            z.array(z.object({ search: z.string(), replace: z.string() })),
            z.object({
              mode: z.enum(["append", "prepend"]),
              content: z.string(),
            }),
          ])
          .optional()
          .describe(
            "Partial update to the card body. " +
              "Provide an array of {search, replace} objects (applied sequentially) " +
              "OR a single {mode: 'append'|'prepend', content} object for boundary additions. " +
              "Mutually exclusive with `body`.",
          ),
        labelIds: z.array(z.string()).optional().describe("Label IDs to apply"),
        assignees: z
          .array(
            z.object({
              type: z.enum(["user", "agent"]),
              id: z.string(),
            }),
          )
          .max(1)
          .optional()
          .describe(
            "Card assignee - array with at most one {type, id} object, or empty to unassign",
          ),
        dueDate: z
          .string()
          .optional()
          .describe("Due date as ISO 8601 string, or null to clear"),
        priority: z
          .enum(["none", "low", "medium", "high", "urgent"])
          .optional()
          .describe("Priority level"),
      })
      .refine((v) => !(v.body !== undefined && v.bodyDiff !== undefined), {
        message: "body and bodyDiff are mutually exclusive",
      }),
    execute: async ({ cardId, columnId, title, label: _label, ...fields }) =>
      asToolResult(async () => {
        if (cardId) {
          return withCardUrl(
            await updateCard(db, ctx, cardId, { title, ...fields }),
          );
        }

        if (!columnId || !title) {
          return {
            error: "columnId and title are required when creating a new card",
          };
        }

        return withCardUrl(
          await createCard(db, ctx, { ...fields, columnId, title }),
        );
      }),
  });

  const moveCardTool = tool({
    description:
      "Move a kanban card to a different position or column. Use afterCardId=null to place at the beginning.",
    inputSchema: z.object({
      cardId: z.string().describe("The card ID to move"),
      label: z.string().describe("The card title (for display purposes)"),
      columnId: z.string().describe("The target column ID"),
      afterCardId: z
        .string()
        .nullable()
        .describe(
          "Place after this card ID, or null to place at the beginning",
        ),
    }),
    execute: async ({ cardId, columnId, afterCardId }) =>
      asToolResult(async () =>
        withCardUrl(await moveCard(db, ctx, { cardId, columnId, afterCardId })),
      ),
  });

  const deleteCard = tool({
    description: "Delete one or more kanban cards.",
    inputSchema: z.object({
      cardIds: z
        .array(z.string())
        .min(1)
        .describe("One or more card IDs to delete"),
      label: z.string().describe("The card title(s) (for display purposes)"),
    }),
    execute: async ({ cardIds }) =>
      asToolResult(async () => {
        await deleteCards(db, ctx, cardIds);
        return { success: true };
      }),
  });

  const listCommentsTool = tool({
    description: "List all comments on a kanban card, ordered oldest first.",
    inputSchema: z.object({
      cardId: z.string().describe("The ID of the card to list comments for"),
      label: z.string().describe("The card title (for display purposes)"),
    }),
    execute: async ({ cardId }) =>
      asToolResult(async () =>
        resolveCommentNames(db, await listComments(db, ctx, cardId)),
      ),
  });

  const upsertComment = tool({
    description:
      "Create a new comment or update an existing comment. If commentId is provided, updates the existing comment. If commentId is not provided, creates a new comment (requires cardId and body).",
    inputSchema: z.object({
      commentId: z
        .string()
        .optional()
        .describe(
          "The comment ID to update. If not provided, a new comment will be created.",
        ),
      label: z
        .string()
        .describe("A short description of the comment (for display purposes)"),
      cardId: z
        .string()
        .optional()
        .describe(
          "The card ID to comment on (required when creating a new comment)",
        ),
      body: z.string().min(1).describe("The comment text (supports markdown)"),
    }),
    execute: async ({ commentId, cardId, body }) =>
      asToolResult(async () => {
        if (commentId) {
          const comment = await requireComment(db, ctx, commentId);
          return updateCommentBody(db, comment, body);
        }

        if (!cardId) {
          return { error: "cardId is required when creating a new comment" };
        }

        return createComment(db, ctx, cardId, body);
      }),
  });

  const deleteComment = tool({
    description: "Delete a kanban card comment.",
    inputSchema: z.object({
      commentId: z.string().describe("The comment ID to delete"),
      label: z
        .string()
        .describe("A short description of the comment (for display purposes)"),
    }),
    execute: async ({ commentId }) =>
      asToolResult(async () => {
        const comment = await requireComment(db, ctx, commentId);
        await removeComment(db, comment);
        return { success: true };
      }),
  });

  const copyCardTool = tool({
    description:
      "Copy a kanban card to a column on the same board, optionally including comments.",
    inputSchema: z.object({
      cardId: z.string().describe("The source card ID to copy"),
      columnId: z
        .string()
        .describe("The target column ID (must be on the same board)"),
      afterCardId: z
        .string()
        .nullable()
        .optional()
        .describe(
          "Place the copy after this card ID, or null/omit to place at the end",
        ),
      includeComments: z
        .boolean()
        .optional()
        .default(false)
        .describe("Whether to copy comments from the source card"),
      label: z.string().describe("The card title (for display purposes)"),
    }),
    execute: async ({ cardId, columnId, afterCardId, includeComments }) =>
      asToolResult(async () =>
        withCardUrl(
          await copyCard(db, ctx, {
            cardId,
            columnId,
            afterCardId,
            includeComments,
          }),
        ),
      ),
  });

  const bulkEditCards = tool({
    description:
      "Update identical property values across multiple cards in a single operation. Only provided fields are applied — omitted fields are left unchanged. labelIds replaces existing labels; addLabelIds/removeLabelIds add or remove labels and are mutually exclusive with labelIds. When columnId is provided, cards are appended to the end of that column in the order they appear in cardIds. Returns per-card results with a summary.",
    inputSchema: z
      .object({
        cardIds: z
          .array(z.string())
          .min(1)
          .max(30)
          .describe("Card IDs to update (max 30)"),
        label: z
          .string()
          .describe(
            "Short description of the operation (for display purposes)",
          ),
        columnId: z
          .string()
          .optional()
          .describe("Move all cards to this column"),
        labelIds: z
          .array(z.string())
          .optional()
          .describe("Set label IDs on all cards, replacing existing labels"),
        addLabelIds: z
          .array(z.string())
          .optional()
          .describe("Add label IDs to all cards, preserving existing labels"),
        removeLabelIds: z
          .array(z.string())
          .optional()
          .describe("Remove label IDs from all cards"),
        assignees: z
          .array(
            z.object({
              type: z.enum(["user", "agent"]),
              id: z.string(),
            }),
          )
          .max(1)
          .optional()
          .describe(
            "Set assignee on all cards — array with at most one {type, id} object, or empty to unassign",
          ),
        priority: z
          .enum(["none", "low", "medium", "high", "urgent"])
          .optional()
          .describe("Set priority on all cards"),
        dueDate: z
          .string()
          .nullable()
          .optional()
          .describe(
            "Set or clear due date on all cards (ISO 8601 string or null)",
          ),
      })
      .refine(
        (data) =>
          !(
            data.labelIds !== undefined &&
            (data.addLabelIds !== undefined ||
              data.removeLabelIds !== undefined)
          ),
        {
          message:
            "labelIds is mutually exclusive with addLabelIds and removeLabelIds",
        },
      ),
    execute: async ({ label: _label, ...input }) =>
      asToolResult(async () => {
        const results = await bulkUpdateCards(db, ctx, input);
        const succeeded = results.filter((r) => r.success).length;

        return {
          results,
          summary: {
            total: results.length,
            succeeded,
            failed: results.length - succeeded,
          },
        };
      }),
  });

  return {
    listAgents,
    listBoards,
    getBoardState,
    getCard,
    upsertCard,
    moveCard: moveCardTool,
    copyCard: copyCardTool,
    deleteCard,
    bulkEditCards,
    listComments: listCommentsTool,
    upsertComment,
    deleteComment,
  };
}

/** What a Tool returns when the module refuses the write. */
type ErrorResult = { error: string };
