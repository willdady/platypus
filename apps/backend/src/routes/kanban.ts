import { Hono, type Context } from "hono";
import { validate } from "../validate.ts";
import { db } from "../index.ts";
import { backendBaseUrl } from "../base-urls.ts";
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
  userOf,
} from "../middleware/authorization.ts";
import type { Variables } from "../server.ts";
import { NotFoundError } from "../errors.ts";
import {
  createBoard,
  deleteBoard,
  getBoardState,
  listBoards,
  resolveBoardState,
  updateBoard,
} from "../services/kanban-board.ts";
import {
  createCard,
  deleteCard,
  moveCard,
  updateCard,
} from "../services/kanban-card.ts";
import { listCardHistory } from "../services/kanban-card-history.ts";
import {
  createColumn,
  deleteColumn,
  renameColumn,
  reorderColumns,
} from "../services/kanban-column.ts";
import {
  createComment,
  listComments,
  removeComment,
  requireComment,
  resolveCommentNames,
  updateCommentBody,
} from "../services/kanban-comment.ts";
import {
  requireBoard,
  type KanbanContext,
  type KanbanScope,
} from "../services/kanban-shared.ts";

const kanban = new Hono<{ Variables: Variables }>();

const scopeOf = (c: Context<{ Variables: Variables }>): KanbanScope => ({
  ...workspaceScopeOf(c),
  boardId: c.req.param("boardId"),
});

const contextOf = (c: Context<{ Variables: Variables }>): KanbanContext => ({
  ...scopeOf(c),
  actor: { userId: userOf(c).id },
});

kanban.get(
  "/",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  async (c) => {
    return c.json({ results: await listBoards(db, workspaceScopeOf(c)) });
  },
);

kanban.post(
  "/",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  requireWorkspaceOwner,
  validate("json", kanbanBoardCreateSchema),
  async (c) => {
    const board = await createBoard(
      db,
      workspaceScopeOf(c),
      c.req.valid("json"),
    );
    return c.json(board, 201);
  },
);

kanban.get(
  "/:boardId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  async (c) => {
    return c.json(await requireBoard(db, scopeOf(c), c.req.param("boardId")));
  },
);

kanban.put(
  "/:boardId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  requireWorkspaceOwner,
  validate("json", kanbanBoardUpdateSchema),
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

kanban.get(
  "/:boardId/state",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  async (c) => {
    const state = await getBoardState(db, scopeOf(c), c.req.param("boardId"));
    return c.json(await resolveBoardState(db, state, backendBaseUrl()));
  },
);

kanban.put(
  "/:boardId/columns/reorder",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  requireWorkspaceOwner,
  validate("json", kanbanColumnReorderSchema),
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

kanban.post(
  "/:boardId/columns",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  requireWorkspaceOwner,
  validate("json", kanbanColumnCreateSchema),
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

kanban.put(
  "/:boardId/columns/:columnId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  requireWorkspaceOwner,
  validate("json", kanbanColumnUpdateSchema),
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

kanban.post(
  "/:boardId/columns/:columnId/cards",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  requireWorkspaceOwner,
  validate("json", kanbanCardCreateSchema),
  async (c) => {
    const { card } = await createCard(db, contextOf(c), {
      ...c.req.valid("json"),
      columnId: c.req.param("columnId"),
    });

    return c.json(card, 201);
  },
);

kanban.patch(
  "/:boardId/cards/:cardId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  requireWorkspaceOwner,
  validate("json", kanbanCardUpdateSchema),
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

kanban.post(
  "/:boardId/cards/:cardId/move",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  requireWorkspaceOwner,
  validate("json", kanbanCardMoveSchema),
  async (c) => {
    const { card } = await moveCard(db, contextOf(c), {
      cardId: c.req.param("cardId"),
      ...c.req.valid("json"),
    });

    return c.json(card);
  },
);

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

const canModerate = (c: Context<{ Variables: Variables }>) =>
  isSuperAdmin(c.get("user")) || c.get("orgMembership")?.role === "admin";

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

kanban.post(
  "/:boardId/cards/:cardId/comments",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  validate("json", kanbanCardCommentCreateSchema),
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

kanban.patch(
  "/:boardId/cards/:cardId/comments/:commentId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  validate("json", kanbanCardCommentUpdateSchema),
  async (c) => {
    const commentId = c.req.param("commentId");
    const existing = await requireCommentOnCard(c, commentId);

    if (!canModerate(c) && existing.createdByUserId !== userOf(c).id) {
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

kanban.delete(
  "/:boardId/cards/:cardId/comments/:commentId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  async (c) => {
    const commentId = c.req.param("commentId");
    const existing = await requireCommentOnCard(c, commentId);

    if (!canModerate(c) && existing.createdByUserId !== userOf(c).id) {
      return c.json({ error: "You can only delete your own comments" }, 403);
    }

    await removeComment(db, existing);
    return c.json({ message: "Comment deleted" });
  },
);

export { kanban };
