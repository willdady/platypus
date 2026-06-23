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
import { buildResourceUrl } from "../utils/resource-url.ts";
import { dispatchEvent } from "../services/event-dispatch.ts";
import { createListAgentsTool } from "./agent-discovery.ts";

export function createKanbanTools(
  workspaceId: string,
  agentId: string,
  orgId: string,
  frontendUrl: string | undefined,
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

  async function getBoardIdForCard(
    cardId: string,
  ): Promise<string | undefined> {
    const result = await db
      .select({ boardId: kanbanColumnTable.boardId })
      .from(kanbanCardTable)
      .innerJoin(
        kanbanColumnTable,
        eq(kanbanCardTable.columnId, kanbanColumnTable.id),
      )
      .where(eq(kanbanCardTable.id, cardId))
      .limit(1);
    return result[0]?.boardId;
  }

  const listAgents = createListAgentsTool(workspaceId);

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
        assignees: { type: "user" | "agent"; id: string }[];
        dueDate: Date | null;
        priority: string;
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
            assignees: kanbanCardTable.assignees,
            dueDate: kanbanCardTable.dueDate,
            priority: kanbanCardTable.priority,
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

      const url = buildResourceUrl(
        frontendUrl,
        orgId,
        workspaceId,
        `boards/${boardId}`,
      );

      return {
        board: boardRecord[0],
        columns: columnsWithCards,
        labels: boardRecord[0].labels,
        ...(url && { url }),
      };
    },
  });

  const getCard = tool({
    description: "Get full details of a specific kanban card.",
    inputSchema: z.object({
      cardId: z.string().describe("The ID of the card to get"),
      label: z.string().describe("The card title (for display purposes)"),
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

      const boardId = await getBoardIdForCard(cardId);
      const url = boardId
        ? buildResourceUrl(
            frontendUrl,
            orgId,
            workspaceId,
            `boards/${boardId}`,
          ) + `?cardId=${cardId}`
        : undefined;

      return { ...card[0], ...(url && { url }) };
    },
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
    execute: async ({
      cardId,
      columnId,
      title,
      body,
      bodyDiff,
      labelIds,
      assignees,
      dueDate,
      priority,
    }) => {
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
        if (bodyDiff !== undefined) {
          const existing = await db
            .select({ body: kanbanCardTable.body })
            .from(kanbanCardTable)
            .where(eq(kanbanCardTable.id, cardId))
            .limit(1);
          const currentBody = existing[0]?.body ?? "";

          let newBody: string;
          if (Array.isArray(bodyDiff)) {
            newBody = currentBody;
            for (const op of bodyDiff) {
              if (!newBody.includes(op.search)) {
                return {
                  error: `bodyDiff search string not found: "${op.search}"`,
                };
              }
              newBody = newBody.replace(op.search, op.replace);
            }
          } else {
            newBody =
              bodyDiff.mode === "append"
                ? currentBody + bodyDiff.content
                : bodyDiff.content + currentBody;
          }
          updateData.body = newBody;
        }
        if (labelIds !== undefined) updateData.labelIds = labelIds;
        if (assignees !== undefined) updateData.assignees = assignees;
        if (dueDate !== undefined)
          updateData.dueDate = dueDate ? new Date(dueDate) : null;
        if (priority !== undefined) updateData.priority = priority;

        const record = await db
          .update(kanbanCardTable)
          .set(updateData)
          .where(eq(kanbanCardTable.id, cardId))
          .returning();

        if (record.length === 0) {
          return { error: "Card not found" };
        }

        const boardId = await getBoardIdForCard(cardId);
        dispatchEvent(
          workspaceId,
          "card.updated",
          { ...record[0], boardId },
          { actorAgentId: agentId },
        );
        const url = boardId
          ? buildResourceUrl(
              frontendUrl,
              orgId,
              workspaceId,
              `boards/${boardId}`,
            ) + `?cardId=${cardId}`
          : undefined;

        return { ...record[0], ...(url && { url }) };
      }

      // Create new card
      if (!columnId || !title) {
        return {
          error: "columnId and title are required when creating a new card",
        };
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
          assignees: assignees ?? [],
          dueDate: dueDate ? new Date(dueDate) : null,
          priority: priority ?? "none",
          position,
          createdByAgentId: agentId,
          createdAt: now,
          updatedAt: now,
        })
        .returning();

      const boardId = await getBoardIdForCard(id);
      dispatchEvent(
        workspaceId,
        "card.created",
        { ...record[0], boardId },
        { actorAgentId: agentId },
      );
      const url = boardId
        ? buildResourceUrl(
            frontendUrl,
            orgId,
            workspaceId,
            `boards/${boardId}`,
          ) + `?cardId=${id}`
        : undefined;

      return { ...record[0], ...(url && { url }) };
    },
  });

  const moveCard = tool({
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

      const boardId = await getBoardIdForCard(cardId);
      dispatchEvent(
        workspaceId,
        "card.updated",
        { ...updated[0], boardId },
        { actorAgentId: agentId },
      );
      const url = boardId
        ? buildResourceUrl(
            frontendUrl,
            orgId,
            workspaceId,
            `boards/${boardId}`,
          ) + `?cardId=${cardId}`
        : undefined;

      return { ...updated[0], ...(url && { url }) };
    },
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
    execute: async ({ cardIds }) => {
      for (const cardId of cardIds) {
        if (!(await verifyCard(cardId))) {
          return { error: `Card not found: ${cardId}` };
        }
      }

      for (const cardId of cardIds) {
        const boardId = await getBoardIdForCard(cardId);
        const cardRecord = await db
          .select({ columnId: kanbanCardTable.columnId })
          .from(kanbanCardTable)
          .where(eq(kanbanCardTable.id, cardId))
          .limit(1);
        const columnId = cardRecord[0]?.columnId;
        await db.delete(kanbanCardTable).where(eq(kanbanCardTable.id, cardId));
        dispatchEvent(
          workspaceId,
          "card.deleted",
          { cardId, boardId, columnId },
          { actorAgentId: agentId },
        );
      }

      return { success: true };
    },
  });

  const listComments = tool({
    description: "List all comments on a kanban card, ordered oldest first.",
    inputSchema: z.object({
      cardId: z.string().describe("The ID of the card to list comments for"),
      label: z.string().describe("The card title (for display purposes)"),
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
      label: z
        .string()
        .describe("A short description of the comment (for display purposes)"),
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

  const copyCard = tool({
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
    execute: async ({ cardId, columnId, afterCardId, includeComments }) => {
      // 1. Verify the source card exists in this workspace
      if (!(await verifyCard(cardId))) {
        return { error: "Card not found" };
      }

      // 2. Verify the target column exists in this workspace
      if (!(await verifyColumn(columnId))) {
        return { error: "Column not found" };
      }

      // 3. Verify both belong to the same board
      const sourceBoardId = await getBoardIdForCard(cardId);

      const targetColumnResult = await db
        .select({ boardId: kanbanColumnTable.boardId })
        .from(kanbanColumnTable)
        .where(eq(kanbanColumnTable.id, columnId))
        .limit(1);
      const targetBoardId = targetColumnResult[0]?.boardId;

      if (sourceBoardId !== targetBoardId) {
        return { error: "Cross-board copy is not allowed" };
      }

      // 4. Fetch source card
      const sourceCards = await db
        .select()
        .from(kanbanCardTable)
        .where(eq(kanbanCardTable.id, cardId))
        .limit(1);
      const sourceCard = sourceCards[0];

      // 5. Calculate position
      let position: number;
      if (afterCardId === null || afterCardId === undefined) {
        // Place at end
        const maxResult = await db
          .select({ maxPos: max(kanbanCardTable.position) })
          .from(kanbanCardTable)
          .where(eq(kanbanCardTable.columnId, columnId));
        position = (maxResult[0]?.maxPos ?? 0) + 1.0;
      } else {
        const cardsInColumn = await db
          .select()
          .from(kanbanCardTable)
          .where(eq(kanbanCardTable.columnId, columnId))
          .orderBy(asc(kanbanCardTable.position));

        let result: ReturnType<typeof calculateCardPosition>;
        try {
          result = calculateCardPosition(cardsInColumn, afterCardId);
        } catch {
          return { error: "afterCardId not found in column" };
        }

        const { position: calcPos, needsRebalance, afterIndex } = result;

        if (needsRebalance) {
          // Rebalance existing cards and place new card at the right spot.
          // Only `.id` is read below, so a minimal {id} shape is enough.
          const reorderedCards: Array<{ id: string }> = [...cardsInColumn];
          reorderedCards.splice(afterIndex + 1, 0, { id: "__placeholder__" });
          for (let i = 0; i < reorderedCards.length; i++) {
            if (reorderedCards[i].id !== "__placeholder__") {
              await db
                .update(kanbanCardTable)
                .set({ position: (i + 1) * 1.0, updatedAt: new Date() })
                .where(eq(kanbanCardTable.id, reorderedCards[i].id));
            }
          }
          position = (afterIndex + 2) * 1.0;
        } else {
          position = calcPos;
        }
      }

      // 6. Insert new card
      const { nanoid } = await import("nanoid");
      const newId = nanoid();
      const now = new Date();

      const record = await db
        .insert(kanbanCardTable)
        .values({
          id: newId,
          columnId,
          title: sourceCard.title,
          body: sourceCard.body,
          labelIds: sourceCard.labelIds,
          assignees: sourceCard.assignees,
          dueDate: sourceCard.dueDate,
          priority: sourceCard.priority,
          position,
          createdByAgentId: agentId,
          createdAt: now,
          updatedAt: now,
        })
        .returning();

      // 7. Copy comments if requested
      if (includeComments) {
        const comments = await db
          .select()
          .from(kanbanCardCommentTable)
          .where(eq(kanbanCardCommentTable.cardId, cardId))
          .orderBy(asc(kanbanCardCommentTable.createdAt));

        for (const comment of comments) {
          await db.insert(kanbanCardCommentTable).values({
            id: nanoid(),
            cardId: newId,
            body: comment.body,
            createdByAgentId: agentId,
            createdAt: now,
            updatedAt: now,
          });
        }
      }

      // 8. Dispatch event
      dispatchEvent(
        workspaceId,
        "card.created",
        { ...record[0], boardId: sourceBoardId },
        { actorAgentId: agentId },
      );

      const url = sourceBoardId
        ? buildResourceUrl(
            frontendUrl,
            orgId,
            workspaceId,
            `boards/${sourceBoardId}`,
          ) + `?cardId=${newId}`
        : undefined;

      return { ...record[0], ...(url && { url }) };
    },
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
    execute: async ({
      cardIds,
      columnId,
      labelIds,
      addLabelIds,
      removeLabelIds,
      assignees,
      priority,
      dueDate,
    }) => {
      if (columnId && !(await verifyColumn(columnId))) {
        return { error: "Column not found" };
      }

      // Verify all cards (best-effort — collect per-card results)
      const failedResults: { cardId: string; success: false; error: string }[] =
        [];
      const validCardIds: string[] = [];
      for (const cardId of cardIds) {
        if (await verifyCard(cardId)) {
          validCardIds.push(cardId);
        } else {
          failedResults.push({
            cardId,
            success: false,
            error: "Card not found",
          });
        }
      }

      if (validCardIds.length === 0) {
        return {
          results: failedResults,
          summary: {
            total: cardIds.length,
            succeeded: 0,
            failed: failedResults.length,
          },
        };
      }

      // Fetch current labels when additive/subtractive ops are requested
      let currentLabelsMap: Map<string, string[]> | undefined;
      if (addLabelIds !== undefined || removeLabelIds !== undefined) {
        const currentCards = await db
          .select({
            id: kanbanCardTable.id,
            labelIds: kanbanCardTable.labelIds,
          })
          .from(kanbanCardTable)
          .where(inArray(kanbanCardTable.id, validCardIds));
        currentLabelsMap = new Map(currentCards.map((c) => [c.id, c.labelIds]));
      }

      // Determine base position for column moves
      let basePosition = 0;
      if (columnId) {
        const maxResult = await db
          .select({ maxPos: max(kanbanCardTable.position) })
          .from(kanbanCardTable)
          .where(eq(kanbanCardTable.columnId, columnId));
        basePosition = maxResult[0]?.maxPos ?? 0;
      }

      // Apply all updates in a single transaction
      await db.transaction(async (tx) => {
        for (let i = 0; i < validCardIds.length; i++) {
          const cardId = validCardIds[i];
          const updateData: Record<string, unknown> = {
            lastEditedByAgentId: agentId,
            updatedAt: new Date(),
          };

          if (columnId !== undefined) {
            updateData.columnId = columnId;
            updateData.position = basePosition + (i + 1) * 1.0;
          }

          if (labelIds !== undefined) {
            updateData.labelIds = labelIds;
          } else if (currentLabelsMap) {
            const current = currentLabelsMap.get(cardId) ?? [];
            let next = [...current];
            if (addLabelIds) {
              next = [...new Set([...next, ...addLabelIds])];
            }
            if (removeLabelIds) {
              next = next.filter((id) => !removeLabelIds.includes(id));
            }
            updateData.labelIds = next;
          }

          if (assignees !== undefined) updateData.assignees = assignees;
          if (priority !== undefined) updateData.priority = priority;
          if (dueDate !== undefined)
            updateData.dueDate = dueDate ? new Date(dueDate) : null;

          await tx
            .update(kanbanCardTable)
            .set(updateData)
            .where(eq(kanbanCardTable.id, cardId));
        }
      });

      // Dispatch events for updated cards
      for (const cardId of validCardIds) {
        const boardId = await getBoardIdForCard(cardId);
        const updated = await db
          .select()
          .from(kanbanCardTable)
          .where(eq(kanbanCardTable.id, cardId))
          .limit(1);
        dispatchEvent(
          workspaceId,
          "card.updated",
          { ...updated[0], boardId },
          { actorAgentId: agentId },
        );
      }

      const succeededResults = validCardIds.map((cardId) => ({
        cardId,
        success: true as const,
      }));

      // Return results in input order
      const resultMap = new Map<
        string,
        { cardId: string; success: boolean; error?: string }
      >([
        ...succeededResults.map((r) => [r.cardId, r] as const),
        ...failedResults.map((r) => [r.cardId, r] as const),
      ]);
      const results = cardIds.map((id) => resultMap.get(id)!);

      return {
        results,
        summary: {
          total: cardIds.length,
          succeeded: validCardIds.length,
          failed: failedResults.length,
        },
      };
    },
  });

  return {
    listAgents,
    listBoards,
    getBoardState,
    getCard,
    upsertCard,
    moveCard,
    copyCard,
    deleteCard,
    bulkEditCards,
    listComments,
    upsertComment,
    deleteComment,
  };
}
