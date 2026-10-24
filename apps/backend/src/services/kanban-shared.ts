import { and, eq, max } from "drizzle-orm";
import { db } from "../index.ts";
import {
  kanbanBoard as kanbanBoardTable,
  kanbanColumn as kanbanColumnTable,
  kanbanCard as kanbanCardTable,
} from "../db/schema.ts";
import { NotFoundError } from "../errors.ts";
import type { ScopeContext } from "../scope.ts";

/**
 * The Kanban board's model: every rule, mutation and read the board has —
 * Boards (`kanban-board.ts`), Columns (`kanban-column.ts`), Cards
 * (`kanban-card.ts`), Card history (`kanban-card-history.ts`) and Comments
 * (`kanban-comment.ts`) — behind an interface both surfaces call. This module
 * holds what more than one of them needs: the scope, the actor, the guards.
 * The HTTP routes and the Agent Tool set are adapters over them — they parse
 * and authorize their own input, call into them, and shape the result (an HTTP
 * envelope, a tool result). The two
 * used to carry a copy each and had already drifted apart, so an Agent could
 * write a label the board does not have and an assignee who cannot work here.
 *
 * Who is acting is a parameter (`KanbanActor`), which is all that separates a
 * human edit from an Agent's: the attribution column written, and whether the
 * dispatched event carries the acting Agent.
 *
 * Failures are the typed errors of ADR-0010 — routes let `app.onError` map them
 * to a status, the Tool adapter maps them to its `{ error }` result.
 */

/** Who is performing the mutation — one of a Workspace member or an Agent. */
export type KanbanActor = { userId: string } | { agentId: string };

/**
 * Where a lookup may reach: a {@link ScopeContext} — so the HTTP surface hands
 * over the `WorkspaceScope` its middleware resolved, unchanged — plus an
 * optional board. `boardId` narrows the reach to a single board (the HTTP
 * surface, which addresses cards through their board); left out, any board in
 * the Workspace matches (the Tool surface, whose Agent works Workspace-wide).
 * Either way the Workspace is the outer boundary — nothing resolves across it.
 */
export type KanbanScope = ScopeContext & {
  boardId?: string;
};

/** A scope plus the actor, for the mutating entry points. */
export type KanbanContext = KanbanScope & { actor: KanbanActor };

/** A card's identity and where it sits — what the guards resolve. */
export type CardRef = { id: string; columnId: string; boardId: string };

/** A column's identity and the board it belongs to. */
export type ColumnRef = { id: string; boardId: string };

/** A column row as stored. */
export type ColumnRow = typeof kanbanColumnTable.$inferSelect;

/** A card row as stored. */
export type CardRow = typeof kanbanCardTable.$inferSelect;

/** A board row as stored. */
export type BoardRow = typeof kanbanBoardTable.$inferSelect;

export type Database = typeof db;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** Any query runner — the top-level `db` or a transaction handle. */
export type Executor = Database | Transaction;

// --- Actor ---

export const isAgent = (actor: KanbanActor): actor is { agentId: string } =>
  "agentId" in actor;

/** The attribution columns for a row this actor is creating. */
export const createdBy = (actor: KanbanActor) =>
  isAgent(actor)
    ? { createdByAgentId: actor.agentId }
    : { createdByUserId: actor.userId };

/** The attribution columns for a row this actor is editing. */
export const lastEditedBy = (actor: KanbanActor) =>
  isAgent(actor)
    ? { lastEditedByAgentId: actor.agentId }
    : { lastEditedByUserId: actor.userId };

export const isoOrNull = (value: Date | null): string | null =>
  value ? value.toISOString() : null;

// --- Scope guards ---

/** The board-side condition every guard joins through: Workspace, then board. */
export const withinScope = (scope: KanbanScope) =>
  and(
    eq(kanbanBoardTable.workspaceId, scope.workspaceId),
    scope.boardId ? eq(kanbanBoardTable.id, scope.boardId) : undefined,
  );

/** The board itself, or `NotFoundError` when it is out of scope. */
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

/**
 * The card, with the board it lives on — or `NotFoundError` when it is out of
 * scope. Resolving the board here is what lets callers dispatch events and
 * build links without a second lookup.
 */
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

/** The column, with its board — or `NotFoundError` when it is out of scope. */
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

// --- Positions ---

/** The tables ordered by a `position` float within a parent. */
type PositionedTable = typeof kanbanCardTable | typeof kanbanColumnTable;

/** One past the highest position in the group — the append-to-end slot. */
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
