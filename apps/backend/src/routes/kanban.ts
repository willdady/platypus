import { Hono, type Context } from "hono";
import { sValidator } from "@hono/standard-validator";
import { nanoid } from "nanoid";
import { and, asc, count, desc, eq, inArray, not } from "drizzle-orm";
import { db } from "../index.ts";
import {
  kanbanBoard as kanbanBoardTable,
  kanbanColumn as kanbanColumnTable,
  kanbanCard as kanbanCardTable,
  kanbanCardComment as kanbanCardCommentTable,
  agent as agentTable,
} from "../db/schema.ts";
import { user } from "../db/auth-schema.ts";
import { avatarKeyToUrl } from "../utils/avatar-url.ts";
import { getOrigin } from "../utils/get-origin.ts";
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
  isSuperAdmin,
  workspaceScopeOf,
} from "../middleware/authorization.ts";
import type { Variables } from "../server.ts";
import { NotFoundError } from "../errors.ts";
import {
  createCard,
  createComment,
  deleteCard,
  listComments,
  moveCard,
  nextColumnPosition,
  pruneCardLabelsForBoard,
  removeComment,
  requireBoard,
  requireComment,
  resolveCommentNames,
  updateCard,
  updateCommentBody,
  type KanbanContext,
  type KanbanScope,
} from "../services/kanban.ts";

/**
 * The human-facing surface over the Kanban module (`services/kanban.ts`): each
 * handler authorizes the request, calls the module, and returns its result.
 * The board's rules live in the module and are shared with the Agent Tool set,
 * and its typed failures are mapped to a status by `app.onError` (ADR-0010).
 */

const kanban = new Hono<{ Variables: Variables }>();

/**
 * Everything the module needs to place this request: the Workspace the
 * middleware already resolved, narrowed to the board this route addresses.
 */
const scopeOf = (c: Context<{ Variables: Variables }>): KanbanScope => ({
  ...workspaceScopeOf(c),
  boardId: c.req.param("boardId"),
});

/** The scope plus the signed-in user, for the handlers that write. */
const contextOf = (c: Context<{ Variables: Variables }>): KanbanContext => ({
  ...scopeOf(c),
  actor: { userId: c.get("user")!.id },
});

// --- Board CRUD ---

/** List all boards in workspace */
kanban.get(
  "/",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  async (c) => {
    const { workspaceId } = workspaceScopeOf(c);
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
    const { workspaceId } = workspaceScopeOf(c);
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
    return c.json(await requireBoard(db, scopeOf(c), c.req.param("boardId")));
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
    const { workspaceId } = workspaceScopeOf(c);
    const data = c.req.valid("json");

    // Labels the update drops are gone from the board, so the cards using them
    // lose them in the same transaction — otherwise a card is left holding an
    // ID that resolves to nothing.
    const record = await db.transaction(async (tx) => {
      const updated = await tx
        .update(kanbanBoardTable)
        .set({ ...data, updatedAt: new Date() })
        .where(
          and(
            eq(kanbanBoardTable.id, boardId),
            eq(kanbanBoardTable.workspaceId, workspaceId),
          ),
        )
        .returning();

      if (updated.length > 0 && data.labels !== undefined) {
        await pruneCardLabelsForBoard(tx, boardId, data.labels);
      }
      return updated;
    });

    if (record.length === 0) throw new NotFoundError("Board not found");

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
    const { workspaceId } = workspaceScopeOf(c);

    const result = await db
      .delete(kanbanBoardTable)
      .where(
        and(
          eq(kanbanBoardTable.id, boardId),
          eq(kanbanBoardTable.workspaceId, workspaceId),
        ),
      )
      .returning();

    if (result.length === 0) throw new NotFoundError("Board not found");

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
    const board = await requireBoard(db, scopeOf(c), boardId);

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
      // Collect assignee IDs
      const assignees = (card.assignees ?? []) as {
        type: "user" | "agent";
        id: string;
      }[];
      for (const a of assignees) {
        if (a.type === "user") userIds.add(a.id);
        else if (a.type === "agent") agentIds.add(a.id);
      }
    }

    // Fetch user names and images
    const users =
      userIds.size > 0
        ? await db
            .select({ id: user.id, name: user.name, image: user.image })
            .from(user)
            .where(inArray(user.id, Array.from(userIds)))
        : [];

    const userMap = new Map(users.map((u) => [u.id, u.name]));
    const userImageMap = new Map(users.map((u) => [u.id, u.image ?? null]));

    // Fetch agent names and avatar keys
    const agents =
      agentIds.size > 0
        ? await db
            .select({
              id: agentTable.id,
              name: agentTable.name,
              avatarKey: agentTable.avatarKey,
            })
            .from(agentTable)
            .where(inArray(agentTable.id, Array.from(agentIds)))
        : [];

    const agentMap = new Map(agents.map((a) => [a.id, a.name]));

    const baseUrl = getOrigin(c);
    const agentAvatarUrlMap = new Map(
      agents.map((a) => [a.id, avatarKeyToUrl(a.avatarKey, baseUrl)]),
    );

    // Add user and agent names to cards, plus resolved assignees
    const cardsWithNames = cards.map((card) => {
      const assignees = (card.assignees ?? []) as {
        type: "user" | "agent";
        id: string;
      }[];
      const resolvedAssignees = assignees
        .map((a) => {
          if (a.type === "user") {
            const name = userMap.get(a.id);
            if (!name) return null;
            return {
              type: "user" as const,
              id: a.id,
              name,
              image: userImageMap.get(a.id) ?? null,
            };
          } else {
            const name = agentMap.get(a.id);
            if (!name) return null;
            return {
              type: "agent" as const,
              id: a.id,
              name,
              image: agentAvatarUrlMap.get(a.id) ?? null,
            };
          }
        })
        .filter(Boolean);

      return {
        ...card,
        dueDate: card.dueDate ? card.dueDate.toISOString() : null,
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
        resolvedAssignees,
        commentCount: commentCountMap.get(card.id) ?? 0,
      };
    });

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
      board,
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
    const { columnIds } = c.req.valid("json");

    await requireBoard(db, scopeOf(c), boardId);

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
    const data = c.req.valid("json");

    await requireBoard(db, scopeOf(c), boardId);

    // Check for duplicate column name within the board
    const existingColumn = await db
      .select({ id: kanbanColumnTable.id })
      .from(kanbanColumnTable)
      .where(
        and(
          eq(kanbanColumnTable.boardId, boardId),
          eq(kanbanColumnTable.name, data.name),
        ),
      )
      .limit(1);

    if (existingColumn.length > 0) {
      return c.json(
        { error: "A column with this name already exists on the board" },
        409,
      );
    }

    const position = await nextColumnPosition(db, boardId);
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

    // Check for duplicate column name within the board (excluding this column)
    const existingColumn = await db
      .select({ id: kanbanColumnTable.id })
      .from(kanbanColumnTable)
      .where(
        and(
          eq(kanbanColumnTable.boardId, boardId),
          eq(kanbanColumnTable.name, data.name),
          not(eq(kanbanColumnTable.id, columnId)),
        ),
      )
      .limit(1);

    if (existingColumn.length > 0) {
      return c.json(
        { error: "A column with this name already exists on the board" },
        409,
      );
    }

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

    if (record.length === 0) throw new NotFoundError("Column not found");

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

    if (result.length === 0) throw new NotFoundError("Column not found");

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
    const { card } = await createCard(db, contextOf(c), {
      ...c.req.valid("json"),
      columnId: c.req.param("columnId"),
    });

    return c.json(card, 201);
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
    const { card } = await updateCard(
      db,
      contextOf(c),
      c.req.param("cardId"),
      c.req.valid("json"),
    );

    return c.json(card);
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
    const { card } = await moveCard(db, contextOf(c), {
      cardId: c.req.param("cardId"),
      ...c.req.valid("json"),
    });

    return c.json(card);
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
    await deleteCard(db, contextOf(c), c.req.param("cardId"));
    return c.json({ message: "Card deleted" });
  },
);

// --- Card Comments ---

/**
 * A comment is addressed through its card, so one that belongs to a different
 * card is not found at this URL even when both are on this board.
 */
const requireCommentOnCard = async (
  c: Context<{ Variables: Variables }>,
  commentId: string,
) => {
  const comment = await requireComment(db, scopeOf(c), commentId);
  if (comment.cardId !== c.req.param("cardId")) {
    throw new NotFoundError("Comment not found");
  }
  return comment;
};

/** Whether this user may edit or delete a comment somebody else wrote. */
const canModerate = (c: Context<{ Variables: Variables }>) =>
  isSuperAdmin(c.get("user")) || c.get("orgMembership")?.role === "admin";

/** List comments for a card */
kanban.get(
  "/:boardId/cards/:cardId/comments",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  async (c) => {
    const comments = await listComments(db, scopeOf(c), c.req.param("cardId"));

    return c.json({ results: await resolveCommentNames(db, comments) });
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
    const comment = await createComment(
      db,
      contextOf(c),
      c.req.param("cardId"),
      c.req.valid("json").body,
    );

    const [enriched] = await resolveCommentNames(db, [comment]);
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
    const commentId = c.req.param("commentId");
    const existing = await requireCommentOnCard(c, commentId);

    if (!canModerate(c) && existing.createdByUserId !== c.get("user")!.id) {
      return c.json({ error: "You can only edit your own comments" }, 403);
    }

    const updated = await updateCommentBody(
      db,
      existing,
      c.req.valid("json").body ?? existing.body,
    );

    const [enriched] = await resolveCommentNames(db, [updated]);
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
    const commentId = c.req.param("commentId");
    const existing = await requireCommentOnCard(c, commentId);

    if (!canModerate(c) && existing.createdByUserId !== c.get("user")!.id) {
      return c.json({ error: "You can only delete your own comments" }, 403);
    }

    await removeComment(db, existing);
    return c.json({ success: true });
  },
);

export { kanban };
