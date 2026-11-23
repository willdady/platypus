import { and, eq, max } from "drizzle-orm";
import type { db } from "../index.ts";
import {
  kanbanBoard as kanbanBoardTable,
  kanbanColumn as kanbanColumnTable,
  kanbanCard as kanbanCardTable,
} from "../db/schema.ts";
import { NotFoundError } from "../errors.ts";
import type { ScopeContext } from "../scope.ts";

export type KanbanActor = { userId: string } | { agentId: string };

export type KanbanScope = ScopeContext & {
  boardId?: string;
};

export type KanbanContext = KanbanScope & { actor: KanbanActor };

export type CardRef = { id: string; columnId: string; boardId: string };

export type ColumnRef = { id: string; boardId: string };

export type ColumnRow = typeof kanbanColumnTable.$inferSelect;

export type CardRow = typeof kanbanCardTable.$inferSelect;

export type BoardRow = typeof kanbanBoardTable.$inferSelect;

export type Database = typeof db;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

export type Executor = Database | Transaction;

export const isAgent = (actor: KanbanActor): actor is { agentId: string } =>
  "agentId" in actor;

export const createdBy = (actor: KanbanActor) =>
  isAgent(actor)
    ? { createdByAgentId: actor.agentId }
    : { createdByUserId: actor.userId };

export const lastEditedBy = (actor: KanbanActor) =>
  isAgent(actor)
    ? { lastEditedByAgentId: actor.agentId }
    : { lastEditedByUserId: actor.userId };

export const isoOrNull = (value: Date | null): string | null =>
  value ? value.toISOString() : null;

export const withinScope = (scope: KanbanScope) =>
  and(
    eq(kanbanBoardTable.workspaceId, scope.workspaceId),
    scope.boardId ? eq(kanbanBoardTable.id, scope.boardId) : undefined,
  );

export const requireBoard = async (
  database: Database,
  scope: KanbanScope,
  boardId: string,
): Promise<BoardRow> => {
  const rows = await database
    .select()
    .from(kanbanBoardTable)
    .where(and(eq(kanbanBoardTable.id, boardId), withinScope(scope)))
    .limit(1);

  const row = rows[0];
  if (!row) throw new NotFoundError("Board not found");
  return row;
};

export const requireCard = async (
  database: Database,
  scope: KanbanScope,
  cardId: string,
): Promise<CardRef> => {
  const rows = await database
    .select({
      id: kanbanCardTable.id,
      columnId: kanbanCardTable.columnId,
      boardId: kanbanColumnTable.boardId,
    })
    .from(kanbanCardTable)
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
    .where(eq(kanbanCardTable.id, cardId))
    .limit(1);

  const row = rows[0];
  if (!row) throw new NotFoundError("Card not found");
  return row;
};

export const requireColumn = async (
  database: Database,
  scope: KanbanScope,
  columnId: string,
): Promise<ColumnRef> => {
  const rows = await database
    .select({
      id: kanbanColumnTable.id,
      boardId: kanbanColumnTable.boardId,
    })
    .from(kanbanColumnTable)
    .innerJoin(
      kanbanBoardTable,
      and(
        eq(kanbanColumnTable.boardId, kanbanBoardTable.id),
        withinScope(scope),
      ),
    )
    .where(eq(kanbanColumnTable.id, columnId))
    .limit(1);

  const row = rows[0];
  if (!row) throw new NotFoundError("Column not found");
  return row;
};

type PositionedTable = typeof kanbanCardTable | typeof kanbanColumnTable;

export const nextPosition = async (
  executor: Executor,
  table: PositionedTable,
  parent: ReturnType<typeof eq>,
): Promise<number> => {
  const rows = await executor
    .select({ maxPos: max(table.position) })
    .from(table)
    .where(parent);

  return (rows[0]?.maxPos ?? 0) + 1.0;
};
