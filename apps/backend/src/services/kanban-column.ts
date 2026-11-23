import { and, eq, inArray, ne } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
  kanbanBoard as kanbanBoardTable,
  kanbanColumn as kanbanColumnTable,
} from "../db/schema.ts";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
  isUniqueViolation,
} from "../errors.ts";
import {
  nextPosition,
  requireBoard,
  requireColumn,
  withinScope,
  type ColumnRow,
  type Database,
  type Executor,
  type KanbanScope,
} from "./kanban-shared.ts";
import { oneRow } from "../db/one-row.ts";

// why: each write puts scope in its own WHERE, so dropping a guard narrows nothing away
const boardIdsInScope = (executor: Executor, scope: KanbanScope) =>
  executor
    .select({ id: kanbanBoardTable.id })
    .from(kanbanBoardTable)
    .where(withinScope(scope));

const columnInScope = (
  executor: Executor,
  scope: KanbanScope,
  columnId: string,
) =>
  and(
    eq(kanbanColumnTable.id, columnId),
    inArray(kanbanColumnTable.boardId, boardIdsInScope(executor, scope)),
  );

const nextColumnPosition = (
  executor: Executor,
  boardId: string,
): Promise<number> =>
  nextPosition(
    executor,
    kanbanColumnTable,
    eq(kanbanColumnTable.boardId, boardId),
  );

const COLUMN_NAME_CLASH = "A column with this name already exists on the board";

const requireUniqueColumnName = async (
  database: Database,
  boardId: string,
  name: string,
  excludeColumnId?: string,
): Promise<void> => {
  const clashes = await database
    .select({ id: kanbanColumnTable.id })
    .from(kanbanColumnTable)
    .where(
      and(
        eq(kanbanColumnTable.boardId, boardId),
        eq(kanbanColumnTable.name, name),
        excludeColumnId ? ne(kanbanColumnTable.id, excludeColumnId) : undefined,
      ),
    )
    .limit(1);

  if (clashes.length > 0) throw new ConflictError(COLUMN_NAME_CLASH);
};

const rethrowAsColumnNameClash = (error: unknown): never => {
  if (isUniqueViolation(error)) throw new ConflictError(COLUMN_NAME_CLASH);
  throw error;
};

const narrowToColumnOnBoard = async (
  database: Database,
  scope: KanbanScope,
  boardId: string,
  columnId: string,
): Promise<KanbanScope> => {
  await requireBoard(database, scope, boardId);
  const onBoard = { ...scope, boardId };
  await requireColumn(database, onBoard, columnId);
  return onBoard;
};

export const createColumn = async (
  database: Database,
  scope: KanbanScope,
  boardId: string,
  input: { name: string },
): Promise<ColumnRow> => {
  await requireBoard(database, scope, boardId);
  await requireUniqueColumnName(database, boardId, input.name);

  const position = await nextColumnPosition(database, boardId);
  const now = new Date();

  const rows = await database
    .insert(kanbanColumnTable)
    .values({
      id: nanoid(),
      name: input.name,
      boardId,
      position,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .catch(rethrowAsColumnNameClash);

  return oneRow(rows);
};

export const renameColumn = async (
  database: Database,
  scope: KanbanScope,
  boardId: string,
  columnId: string,
  input: { name: string },
): Promise<ColumnRow> => {
  const onBoard = await narrowToColumnOnBoard(
    database,
    scope,
    boardId,
    columnId,
  );
  await requireUniqueColumnName(database, boardId, input.name, columnId);

  const rows = await database
    .update(kanbanColumnTable)
    .set({ name: input.name, updatedAt: new Date() })
    .where(columnInScope(database, onBoard, columnId))
    .returning()
    .catch(rethrowAsColumnNameClash);

  const row = rows[0];
  if (!row) throw new NotFoundError("Column not found");
  return row;
};

export const deleteColumn = async (
  database: Database,
  scope: KanbanScope,
  boardId: string,
  columnId: string,
): Promise<void> => {
  const onBoard = await narrowToColumnOnBoard(
    database,
    scope,
    boardId,
    columnId,
  );

  const rows = await database
    .delete(kanbanColumnTable)
    .where(columnInScope(database, onBoard, columnId))
    .returning({ id: kanbanColumnTable.id });

  if (rows.length === 0) throw new NotFoundError("Column not found");
};

export const reorderColumns = async (
  database: Database,
  scope: KanbanScope,
  boardId: string,
  columnIds: string[],
): Promise<void> => {
  await requireBoard(database, scope, boardId);
  const onBoard = { ...scope, boardId };

  const onThisBoard = new Set(
    (
      await database
        .select({ id: kanbanColumnTable.id })
        .from(kanbanColumnTable)
        .where(eq(kanbanColumnTable.boardId, boardId))
    ).map((column) => column.id),
  );
  if (!columnIds.every((id) => onThisBoard.has(id))) {
    throw new ValidationError("Some column IDs do not belong to this board");
  }

  await database.transaction(async (tx) => {
    for (const [index, columnId] of columnIds.entries()) {
      await tx
        .update(kanbanColumnTable)
        .set({ position: (index + 1) * 1.0, updatedAt: new Date() })
        .where(columnInScope(tx, onBoard, columnId));
    }
  });
};
