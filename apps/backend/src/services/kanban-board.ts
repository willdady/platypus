import { and, asc, count, desc, eq, inArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { KanbanCardAssignee, KanbanLabel } from "@platypus/schemas";
import {
  kanbanBoard as kanbanBoardTable,
  kanbanColumn as kanbanColumnTable,
  kanbanCard as kanbanCardTable,
  kanbanCardComment as kanbanCardCommentTable,
  agent as agentTable,
} from "../db/schema.ts";
import { user } from "../db/auth-schema.ts";
import { NotFoundError } from "../errors.ts";
import { avatarKeyToUrl } from "../utils/avatar-url.ts";
import { pruneCardLabelIds } from "../utils/kanban-labels.ts";
import {
  isoOrNull,
  requireBoard,
  withinScope,
  type BoardRow,
  type CardRow,
  type ColumnRow,
  type Database,
  type Executor,
  type KanbanScope,
} from "./kanban-shared.ts";
import { oneRow } from "../db/one-row.ts";

const pruneCardLabelsForBoard = async (
  executor: Executor,
  boardId: string,
  labels: { id: string }[],
): Promise<void> => {
  const cards = await executor
    .select({ id: kanbanCardTable.id, labelIds: kanbanCardTable.labelIds })
    .from(kanbanCardTable)
    .where(
      inArray(
        kanbanCardTable.columnId,
        executor
          .select({ id: kanbanColumnTable.id })
          .from(kanbanColumnTable)
          .where(eq(kanbanColumnTable.boardId, boardId)),
      ),
    );

  const stale = pruneCardLabelIds(
    cards,
    labels.map((label) => label.id),
  );

  for (const card of stale) {
    await executor
      .update(kanbanCardTable)
      .set({ labelIds: card.labelIds, updatedAt: new Date() })
      .where(eq(kanbanCardTable.id, card.id));
  }
};

export type BoardInput = {
  name: string;
  description?: string | null;
  labels?: KanbanLabel[];
};

const DEFAULT_COLUMNS = ["To Do", "In Progress", "Done"];

export const listBoards = (
  database: Database,
  scope: KanbanScope,
): Promise<BoardRow[]> =>
  database
    .select()
    .from(kanbanBoardTable)
    .where(withinScope(scope))
    .orderBy(desc(kanbanBoardTable.createdAt));

export const createBoard = async (
  database: Database,
  scope: KanbanScope,
  input: BoardInput,
): Promise<BoardRow> => {
  const id = nanoid();
  const now = new Date();

  return database.transaction(async (tx) => {
    const rows = await tx
      .insert(kanbanBoardTable)
      .values({
        id,
        ...input,
        workspaceId: scope.workspaceId,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    await tx.insert(kanbanColumnTable).values(
      DEFAULT_COLUMNS.map((name, index) => ({
        id: nanoid(),
        boardId: id,
        name,
        position: (index + 1) * 1.0,
        createdAt: now,
        updatedAt: now,
      })),
    );

    return oneRow(rows);
  });
};

export const updateBoard = async (
  database: Database,
  scope: KanbanScope,
  boardId: string,
  input: Partial<BoardInput>,
): Promise<BoardRow> => {
  const record = await database.transaction(async (tx) => {
    const rows = await tx
      .update(kanbanBoardTable)
      .set({ ...input, updatedAt: new Date() })
      .where(and(eq(kanbanBoardTable.id, boardId), withinScope(scope)))
      .returning();

    const row = rows[0];
    if (row && input.labels !== undefined) {
      await pruneCardLabelsForBoard(tx, boardId, input.labels);
    }
    return row;
  });

  if (!record) throw new NotFoundError("Board not found");
  return record;
};

export const deleteBoard = async (
  database: Database,
  scope: KanbanScope,
  boardId: string,
): Promise<void> => {
  const rows = await database
    .delete(kanbanBoardTable)
    .where(and(eq(kanbanBoardTable.id, boardId), withinScope(scope)))
    .returning({ id: kanbanBoardTable.id });

  if (rows.length === 0) throw new NotFoundError("Board not found");
};

export type BoardState<Card = CardRow> = {
  board: BoardRow;
  columns: (ColumnRow & { cards: Card[] })[];
};

export const getBoardState = async (
  database: Database,
  scope: KanbanScope,
  boardId: string,
): Promise<BoardState> => {
  const board = await requireBoard(database, scope, boardId);

  const columns = await database
    .select()
    .from(kanbanColumnTable)
    .where(eq(kanbanColumnTable.boardId, board.id))
    .orderBy(asc(kanbanColumnTable.position));

  const columnIds = columns.map((column) => column.id);
  const cards =
    columnIds.length > 0
      ? await database
          .select()
          .from(kanbanCardTable)
          .where(inArray(kanbanCardTable.columnId, columnIds))
          .orderBy(asc(kanbanCardTable.position))
      : [];

  const cardsByColumn = new Map<string, CardRow[]>();
  for (const card of cards) {
    const inColumn = cardsByColumn.get(card.columnId) ?? [];
    inColumn.push(card);
    cardsByColumn.set(card.columnId, inColumn);
  }

  return {
    board,
    columns: columns.map((column) => ({
      ...column,
      cards: cardsByColumn.get(column.id) ?? [],
    })),
  };
};

export type ResolvedAssignee = {
  type: KanbanCardAssignee["type"];
  id: string;
  name: string;
  image: string | null;
};

export type ResolvedCard = Omit<CardRow, "dueDate"> & {
  dueDate: string | null;
  createdByName: string | null;
  lastEditedByName: string | null;
  resolvedAssignees: ResolvedAssignee[];
  commentCount: number;
};

export const resolveBoardState = async (
  database: Database,
  state: BoardState,
  baseUrl: string,
): Promise<BoardState<ResolvedCard>> => {
  const cards = state.columns.flatMap((column) => column.cards);
  const cardIds = cards.map((card) => card.id);

  const commentCounts =
    cardIds.length > 0
      ? await database
          .select({ cardId: kanbanCardCommentTable.cardId, count: count() })
          .from(kanbanCardCommentTable)
          .where(inArray(kanbanCardCommentTable.cardId, cardIds))
          .groupBy(kanbanCardCommentTable.cardId)
      : [];
  const commentCountOf = new Map(
    commentCounts.map((row) => [row.cardId, row.count]),
  );

  const userIds = new Set<string>();
  const agentIds = new Set<string>();
  for (const card of cards) {
    if (card.createdByUserId) userIds.add(card.createdByUserId);
    if (card.lastEditedByUserId) userIds.add(card.lastEditedByUserId);
    if (card.createdByAgentId) agentIds.add(card.createdByAgentId);
    if (card.lastEditedByAgentId) agentIds.add(card.lastEditedByAgentId);
    for (const assignee of card.assignees) {
      (assignee.type === "user" ? userIds : agentIds).add(assignee.id);
    }
  }

  const users =
    userIds.size > 0
      ? await database
          .select({ id: user.id, name: user.name, image: user.image })
          .from(user)
          .where(inArray(user.id, Array.from(userIds)))
      : [];
  const agents =
    agentIds.size > 0
      ? await database
          .select({
            id: agentTable.id,
            name: agentTable.name,
            avatarKey: agentTable.avatarKey,
          })
          .from(agentTable)
          .where(inArray(agentTable.id, Array.from(agentIds)))
      : [];

  const userById = new Map(users.map((u) => [u.id, u]));
  const agentById = new Map(agents.map((a) => [a.id, a]));

  const nameOf = (userId: string | null, agentId: string | null) =>
    userId
      ? (userById.get(userId)?.name ?? null)
      : agentId
        ? (agentById.get(agentId)?.name ?? null)
        : null;

  const resolveAssignee = (
    assignee: KanbanCardAssignee,
  ): ResolvedAssignee | null => {
    // why: jsonb hands keys back reordered; build field by field to keep the response shape
    if (assignee.type === "user") {
      const found = userById.get(assignee.id);
      return found?.name
        ? {
            type: "user",
            id: assignee.id,
            name: found.name,
            image: found.image ?? null,
          }
        : null;
    }
    const found = agentById.get(assignee.id);
    return found?.name
      ? {
          type: "agent",
          id: assignee.id,
          name: found.name,
          image: avatarKeyToUrl(found.avatarKey, baseUrl),
        }
      : null;
  };

  const resolveCard = (card: CardRow): ResolvedCard => ({
    ...card,
    dueDate: isoOrNull(card.dueDate),
    createdByName: nameOf(card.createdByUserId, card.createdByAgentId),
    lastEditedByName: nameOf(card.lastEditedByUserId, card.lastEditedByAgentId),
    resolvedAssignees: card.assignees
      .map(resolveAssignee)
      .filter((assignee) => assignee !== null),
    commentCount: commentCountOf.get(card.id) ?? 0,
  });

  return {
    board: state.board,
    columns: state.columns.map((column) => ({
      ...column,
      cards: column.cards.map(resolveCard),
    })),
  };
};
