import { tool, type Tool } from "ai";
import { z } from "zod";
import { and, asc, eq, inArray, max } from "drizzle-orm";
import { db } from "../index.ts";
import {
  kanbanBoard as kanbanBoardTable,
  kanbanColumn as kanbanColumnTable,
  kanbanCard as kanbanCardTable,
  kanbanCardComment as kanbanCardCommentTable,
  agent as agentTable,
} from "../db/schema.ts";
import { user } from "../db/auth-schema.ts";
import { calculateCardPosition } from "../utils/kanban-positioning.ts";

export function createKanbanTools(
  workspaceId: string,
  agentId: string,
): Record<string, Tool> {
  /** Returns true only if the card exists AND belongs to a board in this workspace. */
  async function verifyCard(cardId: string): Promise<boolean> {
    const result = await db
      .select({ id: kanbanCardTable.id })
      .from(kanbanCardTable)
      .innerJoin(
        kanbanColumnTable,
        eq(kanbanCardTable.columnId, kanbanColumnTable.id),
      )
      .innerJoin(
        kanbanBoardTable,
        and(
          eq(kanbanColumnTable.boardId, kanbanBoardTable.id),
          eq(kanbanBoardTable.workspaceId, workspaceId),
        ),
      )
      .where(eq(kanbanCardTable.id, cardId))
      .limit(1);
    return result.length > 0;
  }

  /** Returns true only if the column exists AND belongs to a board in this workspace. */
  async function verifyColumn(columnId: string): Promise<boolean> {
    const result = await db
      .select({ id: kanbanColumnTable.id })
      .from(kanbanColumnTable)
      .innerJoin(
        kanbanBoardTable,
        and(
          eq(kanbanColumnTable.boardId, kanbanBoardTable.id),
          eq(kanbanBoardTable.workspaceId, workspaceId),
        ),
      )
      .where(eq(kanbanColumnTable.id, columnId))
      .limit(1);
    return result.length > 0;
  }

  /** Returns true only if the comment exists AND belongs to a card on a board in this workspace. */
  async function verifyComment(commentId: string): Promise<boolean> {
    const result = await db
      .select({ id: kanbanCardCommentTable.id })
      .from(kanbanCardCommentTable)
      .innerJoin(
        kanbanCardTable,
        eq(kanbanCardCommentTable.cardId, kanbanCardTable.id),
      )
      .innerJoin(
        kanbanColumnTable,
        eq(kanbanCardTable.columnId, kanbanColumnTable.id),
      )
      .innerJoin(
        kanbanBoardTable,
        and(
          eq(kanbanColumnTable.boardId, kanbanBoardTable.id),
          eq(kanbanBoardTable.workspaceId, workspaceId),
        ),
      )
      .where(eq(kanbanCardCommentTable.id, commentId))
      .limit(1);
    return result.length > 0;
  }

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
    }),
    execute: async ({ boardId }) => {
      const boardRecord = await db
        .select()
        .from(kanbanBoardTable)
        .where(
          and(
            eq(kanbanBoardTable.id, boardId),
            eq(kanbanBoardTable.workspaceId, workspaceId),
          ),
        )
        .limit(1);

      if (boardRecord.length === 0) {
        return { error: "Board not found" };
      }

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
      };

      let cards: CardSummary[] = [];
      if (columnIds.length > 0) {
        const fullCards = await db
          .select({
            id: kanbanCardTable.id,
            columnId: kanbanCardTable.columnId,
            title: kanbanCardTable.title,
            position: kanbanCardTable.position,
            labelIds: kanbanCardTable.labelIds,
          })
          .from(kanbanCardTable)
          .where(inArray(kanbanCardTable.columnId, columnIds))
          .orderBy(asc(kanbanCardTable.position));
        cards = fullCards;
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

      return {
        board: boardRecord[0],
        columns: columnsWithCards,
        labels: boardRecord[0].labels,
      };
    },
  });

  const getCard = tool({
    description: "Get full details of a specific kanban card.",
    inputSchema: z.object({
      cardId: z.string().describe("The ID of the card to get"),
    }),
    execute: async ({ cardId }) => {
      if (!(await verifyCard(cardId))) {
        return { error: "Card not found" };
      }

      const card = await db
        .select()
        .from(kanbanCardTable)
        .where(eq(kanbanCardTable.id, cardId))
        .limit(1);

      return card[0];
    },
  });

  const upsertCard = tool({
    description:
      "Create a new card or update an existing card. If cardId is provided, updates the existing card. If cardId is not provided, creates a new card (requires columnId and title).",
    inputSchema: z.object({
      cardId: z
        .string()
        .optional()
        .describe("The card ID to update. If not provided, a new card will be created."),
      columnId: z
        .string()
        .optional()
        .describe("The column ID (required when creating a new card)"),
      title: z
        .string()
        .optional()
        .describe("The card title (required when creating a new card)"),
      body: z.string().optional().describe("The card body/description"),
      labelIds: z.array(z.string()).optional().describe("Label IDs to apply"),
    }),
    execute: async ({ cardId, columnId, title, body, labelIds }) => {
      // Update existing card
      if (cardId) {
        if (!(await verifyCard(cardId))) {
          return { error: "Card not found" };
        }

        const updateData: Record<string, unknown> = {
          lastEditedByAgentId: agentId,
          updatedAt: new Date(),
        };
        if (title !== undefined) updateData.title = title;
        if (body !== undefined) updateData.body = body;
        if (labelIds !== undefined) updateData.labelIds = labelIds;

        const record = await db
          .update(kanbanCardTable)
          .set(updateData)
          .where(eq(kanbanCardTable.id, cardId))
          .returning();

        if (record.length === 0) {
          return { error: "Card not found" };
        }
        return record[0];
      }

      // Create new card
      if (!columnId || !title) {
        return { error: "columnId and title are required when creating a new card" };
      }

      if (!(await verifyColumn(columnId))) {
        return { error: "Column not found" };
      }

      const { nanoid } = await import("nanoid");

      const maxResult = await db
        .select({ maxPos: max(kanbanCardTable.position) })
        .from(kanbanCardTable)
        .where(eq(kanbanCardTable.columnId, columnId));

      const position = (maxResult[0]?.maxPos ?? 0) + 1.0;
      const id = nanoid();
      const now = new Date();

      const record = await db
        .insert(kanbanCardTable)
        .values({
          id,
          columnId,
          title,
          body: body ?? null,
          labelIds: labelIds ?? [],
          position,
          createdByAgentId: agentId,
          createdAt: now,
          updatedAt: now,
        })
        .returning();

      return record[0];
    },
  });

  const moveCard = tool({
    description:
      "Move a kanban card to a different position or column. Use afterCardId=null to place at the beginning.",
    inputSchema: z.object({
      cardId: z.string().describe("The card ID to move"),
      columnId: z.string().describe("The target column ID"),
      afterCardId: z
        .string()
        .nullable()
        .describe(
          "Place after this card ID, or null to place at the beginning",
        ),
    }),
    execute: async ({ cardId, columnId, afterCardId }) => {
      if (!(await verifyCard(cardId))) {
        return { error: "Card not found" };
      }
      if (!(await verifyColumn(columnId))) {
        return { error: "Column not found" };
      }

      const cardsInColumn = await db
        .select()
        .from(kanbanCardTable)
        .where(eq(kanbanCardTable.columnId, columnId))
        .orderBy(asc(kanbanCardTable.position));

      const otherCards = cardsInColumn.filter((card) => card.id !== cardId);

      let result: ReturnType<typeof calculateCardPosition>;
      try {
        result = calculateCardPosition(otherCards, afterCardId);
      } catch {
        return { error: "afterCardId not found in column" };
      }

      const { position, needsRebalance, afterIndex } = result;

      if (needsRebalance) {
        await db.transaction(async (tx) => {
          const reorderedCards: { id: string; position: number }[] = [
            ...otherCards,
          ];
          reorderedCards.splice(afterIndex + 1, 0, {
            id: cardId,
            position: 0,
          });

          for (let i = 0; i < reorderedCards.length; i++) {
            await tx
              .update(kanbanCardTable)
              .set({
                columnId,
                position: (i + 1) * 1.0,
                updatedAt: new Date(),
                ...(reorderedCards[i].id === cardId
                  ? { lastEditedByAgentId: agentId }
                  : {}),
              })
              .where(eq(kanbanCardTable.id, reorderedCards[i].id));
          }
        });
      } else {
        await db
          .update(kanbanCardTable)
          .set({
            columnId,
            position,
            lastEditedByAgentId: agentId,
            updatedAt: new Date(),
          })
          .where(eq(kanbanCardTable.id, cardId));
      }

      const updated = await db
        .select()
        .from(kanbanCardTable)
        .where(eq(kanbanCardTable.id, cardId))
        .limit(1);

      return updated[0];
    },
  });

  const deleteCard = tool({
    description: "Delete a kanban card.",
    inputSchema: z.object({
      cardId: z.string().describe("The card ID to delete"),
    }),
    execute: async ({ cardId }) => {
      if (!(await verifyCard(cardId))) {
        return { error: "Card not found" };
      }

      await db.delete(kanbanCardTable).where(eq(kanbanCardTable.id, cardId));

      return { success: true };
    },
  });

  const listComments = tool({
    description: "List all comments on a kanban card, ordered oldest first.",
    inputSchema: z.object({
      cardId: z.string().describe("The ID of the card to list comments for"),
    }),
    execute: async ({ cardId }) => {
      if (!(await verifyCard(cardId))) {
        return { error: "Card not found" };
      }

      const comments = await db
        .select()
        .from(kanbanCardCommentTable)
        .where(eq(kanbanCardCommentTable.cardId, cardId))
        .orderBy(asc(kanbanCardCommentTable.createdAt));

      const userIds = new Set<string>();
      const agentIds = new Set<string>();
      for (const comment of comments) {
        if (comment.createdByUserId) userIds.add(comment.createdByUserId);
        if (comment.createdByAgentId) agentIds.add(comment.createdByAgentId);
      }

      const users =
        userIds.size > 0
          ? await db
              .select({ id: user.id, name: user.name })
              .from(user)
              .where(inArray(user.id, Array.from(userIds)))
          : [];
      const userMap = new Map(users.map((u) => [u.id, u.name]));

      const agents =
        agentIds.size > 0
          ? await db
              .select({ id: agentTable.id, name: agentTable.name })
              .from(agentTable)
              .where(inArray(agentTable.id, Array.from(agentIds)))
          : [];
      const agentMap = new Map(agents.map((a) => [a.id, a.name]));

      return comments.map((comment) => ({
        ...comment,
        createdByName: comment.createdByUserId
          ? (userMap.get(comment.createdByUserId) ?? null)
          : comment.createdByAgentId
            ? (agentMap.get(comment.createdByAgentId) ?? null)
            : null,
      }));
    },
  });

  const upsertComment = tool({
    description:
      "Create a new comment or update an existing comment. If commentId is provided, updates the existing comment. If commentId is not provided, creates a new comment (requires cardId and body).",
    inputSchema: z.object({
      commentId: z
        .string()
        .optional()
        .describe("The comment ID to update. If not provided, a new comment will be created."),
      cardId: z
        .string()
        .optional()
        .describe("The card ID to comment on (required when creating a new comment)"),
      body: z.string().min(1).describe("The comment text (supports markdown)"),
    }),
    execute: async ({ commentId, cardId, body }) => {
      // Update existing comment
      if (commentId) {
        if (!(await verifyComment(commentId))) {
          return { error: "Comment not found" };
        }

        const record = await db
          .update(kanbanCardCommentTable)
          .set({ body, updatedAt: new Date() })
          .where(eq(kanbanCardCommentTable.id, commentId))
          .returning();

        return record[0];
      }

      // Create new comment
      if (!cardId) {
        return { error: "cardId is required when creating a new comment" };
      }

      if (!(await verifyCard(cardId))) {
        return { error: "Card not found" };
      }

      const { nanoid } = await import("nanoid");
      const id = nanoid();
      const now = new Date();

      const inserted = await db
        .insert(kanbanCardCommentTable)
        .values({
          id,
          cardId,
          body,
          createdByAgentId: agentId,
          createdAt: now,
          updatedAt: now,
        })
        .returning();

      return inserted[0];
    },
  });

  const deleteComment = tool({
    description: "Delete a kanban card comment.",
    inputSchema: z.object({
      commentId: z.string().describe("The comment ID to delete"),
    }),
    execute: async ({ commentId }) => {
      if (!(await verifyComment(commentId))) {
        return { error: "Comment not found" };
      }

      await db
        .delete(kanbanCardCommentTable)
        .where(eq(kanbanCardCommentTable.id, commentId));

      return { success: true };
    },
  });

  return {
    listBoards,
    getBoardState,
    getCard,
    upsertCard,
    moveCard,
    deleteCard,
    listComments,
    upsertComment,
    deleteComment,
  };
}
