import { Hono } from "hono";
import { sValidator } from "@hono/standard-validator";
import { nanoid } from "nanoid";
import { and, asc, count, desc, eq, max, inArray } from "drizzle-orm";
import { db } from "../index.ts";
import {
  kanbanBoard as kanbanBoardTable,
  kanbanColumn as kanbanColumnTable,
  kanbanCard as kanbanCardTable,
  kanbanCardComment as kanbanCardCommentTable,
  agent as agentTable,
} from "../db/schema.ts";
import { user } from "../db/auth-schema.ts";
import {
  kanbanBoardCreateSchema,
  kanbanBoardUpdateSchema,
  kanbanColumnCreateSchema,
  kanbanColumnUpdateSchema,
  kanbanColumnReorderSchema,
  kanbanCardCreateSchema,
  kanbanCardUpdateSchema,
  kanbanCardMoveSchema,
  kanbanCardCommentCreateSchema,
  kanbanCardCommentUpdateSchema,
} from "@platypus/schemas";
import { requireAuth } from "../middleware/authentication.ts";
import {
  requireOrgAccess,
  requireWorkspaceAccess,
  requireWorkspaceOwner,
} from "../middleware/authorization.ts";
import type { Variables } from "../server.ts";
import { calculateCardPosition } from "../utils/kanban-positioning.ts";

const kanban = new Hono<{ Variables: Variables }>();

// --- Board CRUD ---

/** List all boards in workspace */
kanban.get(
  "/",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  async (c) => {
    const workspaceId = c.req.param("workspaceId")!;
    const results = await db
      .select()
      .from(kanbanBoardTable)
      .where(eq(kanbanBoardTable.workspaceId, workspaceId))
      .orderBy(desc(kanbanBoardTable.createdAt));
    return c.json({ results });
  },
);

/** Create a board with default columns */
kanban.post(
  "/",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  requireWorkspaceOwner,
  sValidator("json", kanbanBoardCreateSchema),
  async (c) => {
    const data = c.req.valid("json");
    const workspaceId = c.req.param("workspaceId")!;
    const id = nanoid();
    const now = new Date();

    const record = await db
      .insert(kanbanBoardTable)
      .values({
        id,
        ...data,
        workspaceId,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    // Create default columns
    const defaultColumns = [
      {
        id: nanoid(),
        boardId: id,
        name: "To Do",
        position: 1.0,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: nanoid(),
        boardId: id,
        name: "In Progress",
        position: 2.0,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: nanoid(),
        boardId: id,
        name: "Done",
        position: 3.0,
        createdAt: now,
        updatedAt: now,
      },
    ];
    await db.insert(kanbanColumnTable).values(defaultColumns);

    return c.json(record[0], 201);
  },
);

/** Get a board by ID */
kanban.get(
  "/:boardId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  async (c) => {
    const boardId = c.req.param("boardId");
    const workspaceId = c.req.param("workspaceId")!;

    const record = await db
      .select()
      .from(kanbanBoardTable)
      .where(
        and(
          eq(kanbanBoardTable.id, boardId),
          eq(kanbanBoardTable.workspaceId, workspaceId),
        ),
      )
      .limit(1);

    if (record.length === 0) {
      return c.json({ message: "Board not found" }, 404);
    }

    return c.json(record[0]);
  },
);

/** Update a board */
kanban.put(
  "/:boardId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  requireWorkspaceOwner,
  sValidator("json", kanbanBoardUpdateSchema),
  async (c) => {
    const boardId = c.req.param("boardId");
    const workspaceId = c.req.param("workspaceId")!;
    const data = c.req.valid("json");

    const record = await db
      .update(kanbanBoardTable)
      .set({ ...data, updatedAt: new Date() })
      .where(
        and(
          eq(kanbanBoardTable.id, boardId),
          eq(kanbanBoardTable.workspaceId, workspaceId),
        ),
      )
      .returning();

    if (record.length === 0) {
      return c.json({ message: "Board not found" }, 404);
    }

    return c.json(record[0]);
  },
);

/** Delete a board */
kanban.delete(
  "/:boardId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  requireWorkspaceOwner,
  async (c) => {
    const boardId = c.req.param("boardId");
    const workspaceId = c.req.param("workspaceId")!;

    const result = await db
      .delete(kanbanBoardTable)
      .where(
        and(
          eq(kanbanBoardTable.id, boardId),
          eq(kanbanBoardTable.workspaceId, workspaceId),
        ),
      )
      .returning();

    if (result.length === 0) {
      return c.json({ message: "Board not found" }, 404);
    }

    return c.json({ message: "Board deleted" });
  },
);

// --- Board State ---

/** Get full board state */
kanban.get(
  "/:boardId/state",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  async (c) => {
    const boardId = c.req.param("boardId");
    const workspaceId = c.req.param("workspaceId")!;

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
      return c.json({ message: "Board not found" }, 404);
    }

    const columns = await db
      .select()
      .from(kanbanColumnTable)
      .where(eq(kanbanColumnTable.boardId, boardId))
      .orderBy(asc(kanbanColumnTable.position));

    const columnIds = columns.map((col) => col.id);

    let cards: (typeof kanbanCardTable.$inferSelect)[] = [];
    if (columnIds.length > 0) {
      cards = await db
        .select()
        .from(kanbanCardTable)
        .where(inArray(kanbanCardTable.columnId, columnIds))
        .orderBy(asc(kanbanCardTable.position));
    }

    // Fetch comment counts per card
    const cardIds = cards.map((card) => card.id);
    const commentCounts =
      cardIds.length > 0
        ? await db
            .select({
              cardId: kanbanCardCommentTable.cardId,
              count: count(),
            })
            .from(kanbanCardCommentTable)
            .where(inArray(kanbanCardCommentTable.cardId, cardIds))
            .groupBy(kanbanCardCommentTable.cardId)
        : [];
    const commentCountMap = new Map(
      commentCounts.map((cc) => [cc.cardId, cc.count]),
    );

    // Collect unique user IDs and agent IDs to fetch names
    const userIds = new Set<string>();
    const agentIds = new Set<string>();
    for (const card of cards) {
      if (card.createdByUserId) userIds.add(card.createdByUserId);
      if (card.lastEditedByUserId) userIds.add(card.lastEditedByUserId);
      if (card.createdByAgentId) agentIds.add(card.createdByAgentId);
      if (card.lastEditedByAgentId) agentIds.add(card.lastEditedByAgentId);
    }

    // Fetch user names
    const users =
      userIds.size > 0
        ? await db
            .select({ id: user.id, name: user.name })
            .from(user)
            .where(inArray(user.id, Array.from(userIds)))
        : [];

    const userMap = new Map(users.map((u) => [u.id, u.name]));

    // Fetch agent names
    const agents =
      agentIds.size > 0
        ? await db
            .select({ id: agentTable.id, name: agentTable.name })
            .from(agentTable)
            .where(inArray(agentTable.id, Array.from(agentIds)))
        : [];

    const agentMap = new Map(agents.map((a) => [a.id, a.name]));

    // Add user and agent names to cards
    const cardsWithNames = cards.map((card) => ({
      ...card,
      createdByName: card.createdByUserId
        ? (userMap.get(card.createdByUserId) ?? null)
        : card.createdByAgentId
          ? (agentMap.get(card.createdByAgentId) ?? null)
          : null,
      lastEditedByName: card.lastEditedByUserId
        ? (userMap.get(card.lastEditedByUserId) ?? null)
        : card.lastEditedByAgentId
          ? (agentMap.get(card.lastEditedByAgentId) ?? null)
          : null,
      commentCount: commentCountMap.get(card.id) ?? 0,
    }));

    // Nest cards into columns
    const cardsByColumn = new Map<string, typeof cardsWithNames>();
    for (const card of cardsWithNames) {
      const existing = cardsByColumn.get(card.columnId) ?? [];
      existing.push(card);
      cardsByColumn.set(card.columnId, existing);
    }

    const columnsWithCards = columns.map((col) => ({
      ...col,
      cards: cardsByColumn.get(col.id) ?? [],
    }));

    return c.json({
      board: boardRecord[0],
      columns: columnsWithCards,
    });
  },
);

// --- Column CRUD ---

/** Reorder columns (must be before /:boardId/columns/:columnId) */
kanban.put(
  "/:boardId/columns/reorder",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  requireWorkspaceOwner,
  sValidator("json", kanbanColumnReorderSchema),
  async (c) => {
    const boardId = c.req.param("boardId");
    const workspaceId = c.req.param("workspaceId")!;
    const { columnIds } = c.req.valid("json");

    // Verify board belongs to workspace
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
      return c.json({ message: "Board not found" }, 404);
    }

    // Validate all columnIds belong to this board
    const boardColumns = await db
      .select({ id: kanbanColumnTable.id })
      .from(kanbanColumnTable)
      .where(eq(kanbanColumnTable.boardId, boardId))
      .orderBy(asc(kanbanColumnTable.position));

    const boardColumnIds = new Set(boardColumns.map((col) => col.id));
    const allBelong = columnIds.every((id: string) => boardColumnIds.has(id));
    if (!allBelong) {
      return c.json(
        { message: "Some column IDs do not belong to this board" },
        400,
      );
    }

    await db.transaction(async (tx) => {
      for (let i = 0; i < columnIds.length; i++) {
        await tx
          .update(kanbanColumnTable)
          .set({ position: (i + 1) * 1.0, updatedAt: new Date() })
          .where(
            and(
              eq(kanbanColumnTable.id, columnIds[i]),
              eq(kanbanColumnTable.boardId, boardId),
            ),
          );
      }
    });

    return c.json({ message: "Columns reordered" });
  },
);

/** Create a column */
kanban.post(
  "/:boardId/columns",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  requireWorkspaceOwner,
  sValidator("json", kanbanColumnCreateSchema),
  async (c) => {
    const boardId = c.req.param("boardId");
    const workspaceId = c.req.param("workspaceId")!;
    const data = c.req.valid("json");

    // Verify board belongs to workspace
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
      return c.json({ message: "Board not found" }, 404);
    }

    const maxResult = await db
      .select({ maxPos: max(kanbanColumnTable.position) })
      .from(kanbanColumnTable)
      .where(eq(kanbanColumnTable.boardId, boardId));

    const position = (maxResult[0]?.maxPos ?? 0) + 1.0;

    const id = nanoid();
    const now = new Date();

    const record = await db
      .insert(kanbanColumnTable)
      .values({
        id,
        ...data,
        boardId,
        position,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    return c.json(record[0], 201);
  },
);

/** Update a column */
kanban.put(
  "/:boardId/columns/:columnId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  requireWorkspaceOwner,
  sValidator("json", kanbanColumnUpdateSchema),
  async (c) => {
    const columnId = c.req.param("columnId");
    const boardId = c.req.param("boardId");
    const data = c.req.valid("json");

    const record = await db
      .update(kanbanColumnTable)
      .set({ ...data, updatedAt: new Date() })
      .where(
        and(
          eq(kanbanColumnTable.id, columnId),
          eq(kanbanColumnTable.boardId, boardId),
        ),
      )
      .returning();

    if (record.length === 0) {
      return c.json({ message: "Column not found" }, 404);
    }

    return c.json(record[0]);
  },
);

/** Delete a column */
kanban.delete(
  "/:boardId/columns/:columnId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  requireWorkspaceOwner,
  async (c) => {
    const columnId = c.req.param("columnId");
    const boardId = c.req.param("boardId");

    const result = await db
      .delete(kanbanColumnTable)
      .where(
        and(
          eq(kanbanColumnTable.id, columnId),
          eq(kanbanColumnTable.boardId, boardId),
        ),
      )
      .returning();

    if (result.length === 0) {
      return c.json({ message: "Column not found" }, 404);
    }

    return c.json({ message: "Column deleted" });
  },
);

// --- Card CRUD + Move ---

/** Create a card */
kanban.post(
  "/:boardId/columns/:columnId/cards",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  requireWorkspaceOwner,
  sValidator("json", kanbanCardCreateSchema),
  async (c) => {
    const boardId = c.req.param("boardId");
    const columnId = c.req.param("columnId");
    const data = c.req.valid("json");
    const user = c.get("user")!;

    // Verify column belongs to this board
    const columnRecord = await db
      .select()
      .from(kanbanColumnTable)
      .where(
        and(
          eq(kanbanColumnTable.id, columnId),
          eq(kanbanColumnTable.boardId, boardId),
        ),
      )
      .limit(1);

    if (columnRecord.length === 0) {
      return c.json({ message: "Column not found" }, 404);
    }

    // Validate labelIds if provided
    if (data.labelIds && data.labelIds.length > 0) {
      const boardRecord = await db
        .select({ labels: kanbanBoardTable.labels })
        .from(kanbanBoardTable)
        .where(eq(kanbanBoardTable.id, boardId))
        .limit(1);

      const boardLabelIds = new Set(
        (boardRecord[0]?.labels ?? []).map(
          (l: { id: string }) => l.id,
        ),
      );
      const allValid = data.labelIds.every((id: string) =>
        boardLabelIds.has(id),
      );
      if (!allValid) {
        return c.json({ message: "Invalid label ID" }, 400);
      }
    }

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
        ...data,
        columnId,
        position,
        createdByUserId: user.id,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    return c.json(record[0], 201);
  },
);

/** Update a card */
kanban.put(
  "/:boardId/cards/:cardId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  requireWorkspaceOwner,
  sValidator("json", kanbanCardUpdateSchema),
  async (c) => {
    const boardId = c.req.param("boardId");
    const cardId = c.req.param("cardId");
    const data = c.req.valid("json");
    const user = c.get("user")!;

    // Validate labelIds if provided
    if (data.labelIds && data.labelIds.length > 0) {
      const boardRecord = await db
        .select({ labels: kanbanBoardTable.labels })
        .from(kanbanBoardTable)
        .where(eq(kanbanBoardTable.id, boardId))
        .limit(1);

      const boardLabelIds = new Set(
        (boardRecord[0]?.labels ?? []).map(
          (l: { id: string }) => l.id,
        ),
      );
      const allValid = data.labelIds.every((id: string) =>
        boardLabelIds.has(id),
      );
      if (!allValid) {
        return c.json({ message: "Invalid label ID" }, 400);
      }
    }

    const record = await db
      .update(kanbanCardTable)
      .set({
        ...data,
        lastEditedByUserId: user.id,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(kanbanCardTable.id, cardId),
          inArray(
            kanbanCardTable.columnId,
            db
              .select({ id: kanbanColumnTable.id })
              .from(kanbanColumnTable)
              .where(eq(kanbanColumnTable.boardId, boardId)),
          ),
        ),
      )
      .returning();

    if (record.length === 0) {
      return c.json({ message: "Card not found" }, 404);
    }

    return c.json(record[0]);
  },
);

/** Move a card */
kanban.post(
  "/:boardId/cards/:cardId/move",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  requireWorkspaceOwner,
  sValidator("json", kanbanCardMoveSchema),
  async (c) => {
    const cardId = c.req.param("cardId");
    const { columnId, afterCardId } = c.req.valid("json");
    const user = c.get("user")!;

    // Get cards in target column sorted by position
    const cardsInColumn = await db
      .select()
      .from(kanbanCardTable)
      .where(eq(kanbanCardTable.columnId, columnId))
      .orderBy(asc(kanbanCardTable.position));

    // Filter out the card being moved (in case it's in the same column)
    const otherCards = cardsInColumn.filter((card) => card.id !== cardId);

    let result: ReturnType<typeof calculateCardPosition>;
    try {
      result = calculateCardPosition(otherCards, afterCardId);
    } catch {
      return c.json({ message: "afterCardId not found in column" }, 400);
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
                ? { lastEditedByUserId: user.id }
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
          lastEditedByUserId: user.id,
          updatedAt: new Date(),
        })
        .where(eq(kanbanCardTable.id, cardId));
    }

    const updated = await db
      .select()
      .from(kanbanCardTable)
      .where(eq(kanbanCardTable.id, cardId))
      .limit(1);

    return c.json(updated[0]);
  },
);

/** Delete a card */
kanban.delete(
  "/:boardId/cards/:cardId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  requireWorkspaceOwner,
  async (c) => {
    const boardId = c.req.param("boardId");
    const cardId = c.req.param("cardId");

    const result = await db
      .delete(kanbanCardTable)
      .where(
        and(
          eq(kanbanCardTable.id, cardId),
          inArray(
            kanbanCardTable.columnId,
            db
              .select({ id: kanbanColumnTable.id })
              .from(kanbanColumnTable)
              .where(eq(kanbanColumnTable.boardId, boardId)),
          ),
        ),
      )
      .returning();

    if (result.length === 0) {
      return c.json({ message: "Card not found" }, 404);
    }

    return c.json({ message: "Card deleted" });
  },
);

// --- Card Comments ---

async function resolveCommentNames(
  comments: (typeof kanbanCardCommentTable.$inferSelect)[],
) {
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
}

/** List comments for a card */
kanban.get(
  "/:boardId/cards/:cardId/comments",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  async (c) => {
    const boardId = c.req.param("boardId");
    const cardId = c.req.param("cardId");
    const workspaceId = c.req.param("workspaceId")!;

    const cardRecord = await db
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
          eq(kanbanBoardTable.id, boardId),
          eq(kanbanBoardTable.workspaceId, workspaceId),
        ),
      )
      .where(eq(kanbanCardTable.id, cardId))
      .limit(1);

    if (cardRecord.length === 0) {
      return c.json({ message: "Card not found" }, 404);
    }

    const comments = await db
      .select()
      .from(kanbanCardCommentTable)
      .where(eq(kanbanCardCommentTable.cardId, cardId))
      .orderBy(asc(kanbanCardCommentTable.createdAt));

    const enriched = await resolveCommentNames(comments);
    return c.json({ results: enriched });
  },
);

/** Create a comment on a card */
kanban.post(
  "/:boardId/cards/:cardId/comments",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  sValidator("json", kanbanCardCommentCreateSchema),
  async (c) => {
    const boardId = c.req.param("boardId");
    const cardId = c.req.param("cardId");
    const workspaceId = c.req.param("workspaceId")!;
    const data = c.req.valid("json");
    const currentUser = c.get("user")!;

    const cardRecord = await db
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
          eq(kanbanBoardTable.id, boardId),
          eq(kanbanBoardTable.workspaceId, workspaceId),
        ),
      )
      .where(eq(kanbanCardTable.id, cardId))
      .limit(1);

    if (cardRecord.length === 0) {
      return c.json({ message: "Card not found" }, 404);
    }

    const id = nanoid();
    const now = new Date();

    const inserted = await db
      .insert(kanbanCardCommentTable)
      .values({
        id,
        cardId,
        body: data.body,
        createdByUserId: currentUser.id,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    const [enriched] = await resolveCommentNames(inserted);
    return c.json(enriched, 201);
  },
);

/** Update a comment */
kanban.put(
  "/:boardId/cards/:cardId/comments/:commentId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  sValidator("json", kanbanCardCommentUpdateSchema),
  async (c) => {
    const cardId = c.req.param("cardId");
    const commentId = c.req.param("commentId");
    const data = c.req.valid("json");

    const updated = await db
      .update(kanbanCardCommentTable)
      .set({ ...data, updatedAt: new Date() })
      .where(
        and(
          eq(kanbanCardCommentTable.id, commentId),
          eq(kanbanCardCommentTable.cardId, cardId),
        ),
      )
      .returning();

    if (updated.length === 0) {
      return c.json({ message: "Comment not found" }, 404);
    }

    const [enriched] = await resolveCommentNames(updated);
    return c.json(enriched);
  },
);

/** Delete a comment */
kanban.delete(
  "/:boardId/cards/:cardId/comments/:commentId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  async (c) => {
    const cardId = c.req.param("cardId");
    const commentId = c.req.param("commentId");

    const result = await db
      .delete(kanbanCardCommentTable)
      .where(
        and(
          eq(kanbanCardCommentTable.id, commentId),
          eq(kanbanCardCommentTable.cardId, cardId),
        ),
      )
      .returning();

    if (result.length === 0) {
      return c.json({ message: "Comment not found" }, 404);
    }

    return c.json({ success: true });
  },
);

export { kanban };
