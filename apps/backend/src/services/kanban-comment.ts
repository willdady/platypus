import { and, asc, eq, inArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
  kanbanBoard as kanbanBoardTable,
  kanbanColumn as kanbanColumnTable,
  kanbanCard as kanbanCardTable,
  kanbanCardComment as kanbanCardCommentTable,
  agent as agentTable,
} from "../db/schema.ts";
import { user } from "../db/auth-schema.ts";
import { NotFoundError } from "../errors.ts";
import {
  createdBy,
  requireCard,
  withinScope,
  type Database,
  type KanbanContext,
  type KanbanScope,
} from "./kanban-shared.ts";

/** A comment row, as the guards return it. */
export type CommentRow = typeof kanbanCardCommentTable.$inferSelect;

/**
 * The comment — or `NotFoundError` when its card is out of scope. Returns the
 * whole row because every caller needs it: to check who wrote it, or to hand
 * it back.
 */
export const requireComment = async (
  database: Database,
  scope: KanbanScope,
  commentId: string,
): Promise<CommentRow> => {
  const rows = await database
    .select({
      id: kanbanCardCommentTable.id,
      cardId: kanbanCardCommentTable.cardId,
      body: kanbanCardCommentTable.body,
      createdByUserId: kanbanCardCommentTable.createdByUserId,
      createdByAgentId: kanbanCardCommentTable.createdByAgentId,
      createdAt: kanbanCardCommentTable.createdAt,
      updatedAt: kanbanCardCommentTable.updatedAt,
    })
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
        withinScope(scope),
      ),
    )
    .where(eq(kanbanCardCommentTable.id, commentId))
    .limit(1);

  const row = rows[0];
  if (!row) throw new NotFoundError("Comment not found");
  return row;
};

/** A comment with the display name of whoever wrote it, user or Agent. */
export type CommentWithAuthor = CommentRow & { createdByName: string | null };

/**
 * Resolves each comment's author to a name. Comments store only an ID, and the
 * author is a user or an Agent depending on which column is set.
 */
export const resolveCommentNames = async (
  database: Database,
  comments: CommentRow[],
): Promise<CommentWithAuthor[]> => {
  const userIds = new Set<string>();
  const agentIds = new Set<string>();
  for (const comment of comments) {
    if (comment.createdByUserId) userIds.add(comment.createdByUserId);
    if (comment.createdByAgentId) agentIds.add(comment.createdByAgentId);
  }

  const users =
    userIds.size > 0
      ? await database
          .select({ id: user.id, name: user.name })
          .from(user)
          .where(inArray(user.id, Array.from(userIds)))
      : [];
  const userMap = new Map(users.map((u) => [u.id, u.name]));

  const agents =
    agentIds.size > 0
      ? await database
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
};

/** A card's comments, oldest first. */
export const listComments = async (
  database: Database,
  scope: KanbanScope,
  cardId: string,
): Promise<CommentRow[]> => {
  await requireCard(database, scope, cardId);

  return database
    .select()
    .from(kanbanCardCommentTable)
    .where(eq(kanbanCardCommentTable.cardId, cardId))
    .orderBy(asc(kanbanCardCommentTable.createdAt));
};

/** Adds a comment to a card, attributed to the actor. */
export const createComment = async (
  database: Database,
  ctx: KanbanContext,
  cardId: string,
  body: string,
): Promise<CommentRow> => {
  await requireCard(database, ctx, cardId);

  const now = new Date();
  const rows = await database
    .insert(kanbanCardCommentTable)
    .values({
      id: nanoid(),
      cardId,
      body,
      ...createdBy(ctx.actor),
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  return rows[0];
};

/**
 * Rewrites a comment's body. It takes the comment rather than an ID because
 * only `requireComment` produces one, which keeps the scope check mandatory.
 * Who may then edit which comment is the surface's own call — the HTTP routes
 * let a moderator edit anyone's.
 */
export const updateCommentBody = async (
  database: Database,
  comment: CommentRow,
  body: string,
): Promise<CommentRow> => {
  const rows = await database
    .update(kanbanCardCommentTable)
    .set({ body, updatedAt: new Date() })
    .where(eq(kanbanCardCommentTable.id, comment.id))
    .returning();

  return rows[0];
};

/** Deletes a comment the caller has already resolved. */
export const removeComment = async (
  database: Database,
  comment: CommentRow,
): Promise<void> => {
  await database
    .delete(kanbanCardCommentTable)
    .where(eq(kanbanCardCommentTable.id, comment.id));
};
