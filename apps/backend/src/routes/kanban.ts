import { Hono, type Context } from "hono";
import { sValidator } from "@hono/standard-validator";
import { db } from "../index.ts";
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
  createBoard,
  createCard,
  createColumn,
  createComment,
  deleteBoard,
  deleteCard,
  deleteColumn,
  getBoardState,
  listBoards,
  listCardHistory,
  listComments,
  moveCard,
  removeComment,
  renameColumn,
  reorderColumns,
  requireBoard,
  requireComment,
  resolveBoardState,
  resolveCommentNames,
  updateBoard,
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
    return c.json({ results: await listBoards(db, workspaceScopeOf(c)) });
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
    const board = await createBoard(
      db,
      workspaceScopeOf(c),
      c.req.valid("json"),
    );
    return c.json(board, 201);
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
    const board = await updateBoard(
      db,
      scopeOf(c),
      c.req.param("boardId"),
      c.req.valid("json"),
    );
    return c.json(board);
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
    await deleteBoard(db, scopeOf(c), c.req.param("boardId"));
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
    const state = await getBoardState(db, scopeOf(c), c.req.param("boardId"));
    return c.json(await resolveBoardState(db, state, getOrigin(c)));
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
    await reorderColumns(
      db,
      scopeOf(c),
      c.req.param("boardId"),
      c.req.valid("json").columnIds,
    );
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
    const column = await createColumn(
      db,
      scopeOf(c),
      c.req.param("boardId"),
      c.req.valid("json"),
    );
    return c.json(column, 201);
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
    const column = await renameColumn(
      db,
      scopeOf(c),
      c.req.param("boardId"),
      c.req.param("columnId"),
      c.req.valid("json"),
    );
    return c.json(column);
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
    await deleteColumn(
      db,
      scopeOf(c),
      c.req.param("boardId"),
      c.req.param("columnId"),
    );
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

/** A card's history, newest first */
kanban.get(
  "/:boardId/cards/:cardId/history",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  async (c) => {
    const results = await listCardHistory(
      db,
      scopeOf(c),
      c.req.param("cardId"),
    );

    return c.json({ results });
  },
);

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
