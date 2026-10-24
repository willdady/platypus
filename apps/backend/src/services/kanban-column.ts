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

/**
 * The ids of every board in scope, as a subquery. A board or column write puts
 * this — or {@link withinScope} itself — in its own `WHERE`, rather than
 * relying on a guard that ran first: dropping the guard then narrows nothing
 * away, the same rule `ownedWhere` states for Workspace-child resources.
 */
const boardIdsInScope = (executor: Executor, scope: KanbanScope) =>
  executor
    .select({ id: kanbanBoardTable.id })
    .from(kanbanBoardTable)
    .where(withinScope(scope));

/** One column, matched only while its board is in scope. */
const columnInScope = (
  executor: Executor,
  scope: KanbanScope,
  columnId: string,
) =>
  and(
    eq(kanbanColumnTable.id, columnId),
    inArray(kanbanColumnTable.boardId, boardIdsInScope(executor, scope)),
  );

/** The position a column appended to the end of a board would take. */
const nextColumnPosition = (
  executor: Executor,
  boardId: string,
): Promise<number> =>
  nextPosition(
    executor,
    kanbanColumnTable,
    eq(kanbanColumnTable.boardId, boardId),
  );

// --- Columns ---

const COLUMN_NAME_CLASH = "A column with this name already exists on the board";

/**
 * Column names are unique per board. The friendly fast path: the board's
 * unique constraint is the backstop for a write that lands between this check
 * and its own, which {@link rethrowAsColumnNameClash} turns into the same conflict.
 */
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

/** A column write's unique violation as the name clash it is. */
const rethrowAsColumnNameClash = (error: unknown): never => {
  if (isUniqueViolation(error)) throw new ConflictError(COLUMN_NAME_CLASH);
  throw error;
};

/**
 * A column addressed through its board: the board must be in scope, and the
 * column on that board. Returns the scope narrowed to that board, for the
 * write's own `WHERE`. The two misses stay distinct, so a caller naming a
 * board it cannot see hears about the board rather than the column.
 */
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

/** Adds a column to the end of a board. */
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

  return rows[0];
};

/** Renames a column. Keeping its own name is not a clash. */
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

/**
 * Deletes a column; its cards go with it by FK cascade.
 *
 * Silent by decision, as with `deleteBoard`: the cascaded cards fire no
 * `card.deleted`.
 */
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

/**
 * Puts a board's columns in the order given, at positions 1..n. Every id must
 * be on the board; one that is not refuses the whole reorder.
 */
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
