import { and, asc, eq, inArray, max } from "drizzle-orm";
import { nanoid } from "nanoid";
import type {
  KanbanCardAssignee,
  KanbanCardPriority,
  WebhookEvent,
} from "@platypus/schemas";
import { db } from "../index.ts";
import {
  kanbanBoard as kanbanBoardTable,
  kanbanColumn as kanbanColumnTable,
  kanbanCard as kanbanCardTable,
  kanbanCardComment as kanbanCardCommentTable,
  agent as agentTable,
  organizationMember as organizationMemberTable,
} from "../db/schema.ts";
import { user } from "../db/auth-schema.ts";
import { NotFoundError, ValidationError } from "../errors.ts";
import type { ScopeContext } from "../scope.ts";
import { dispatchEvent } from "./event-dispatch.ts";
import { listScopedByIds } from "./scoped-resource.ts";
import { calculateCardPosition } from "../utils/kanban-positioning.ts";
import {
  filterKnownLabelIds,
  pruneCardLabelIds,
} from "../utils/kanban-labels.ts";

/**
 * The Kanban board's write model: every rule and mutation the board has, in one
 * place, behind an interface both surfaces call. The HTTP routes and the Agent
 * Tool set are adapters over it — they parse and authorize their own input,
 * call in here, and shape the result (an HTTP envelope, a tool result). The two
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

/** A comment row, as the guards return it. */
export type CommentRow = typeof kanbanCardCommentTable.$inferSelect;

/** A card row as stored. */
export type CardRow = typeof kanbanCardTable.$inferSelect;

/** A board row as stored. */
export type BoardRow = typeof kanbanBoardTable.$inferSelect;

/**
 * A written card and the board it is on. The board comes back with it because
 * a card row does not name its board — only its column — and both surfaces
 * need it: to announce the change, and to link to it.
 */
export type CardResult = { card: CardRow; boardId: string };

type Database = typeof db;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** Any query runner — the top-level `db` or a transaction handle. */
type Executor = Database | Transaction;

/** The fields a card mutation accepts, whichever surface it arrived on. */
export type CardInput = {
  title?: string;
  body?: string | null;
  /** A partial edit of the body, resolved against what the card holds now. */
  bodyDiff?: BodyDiff;
  labelIds?: string[];
  assignees?: KanbanCardAssignee[];
  dueDate?: string | null;
  priority?: KanbanCardPriority;
};

/**
 * A partial edit of a card's body: an ordered list of search/replace pairs, or
 * a single addition at one end. Offered by the Tool surface so an Agent can
 * amend a long body without resending it.
 */
export type BodyDiff =
  | { search: string; replace: string }[]
  | { mode: "append" | "prepend"; content: string };

// --- Actor ---

const isAgent = (actor: KanbanActor): actor is { agentId: string } =>
  "agentId" in actor;

/** The attribution columns for a row this actor is creating. */
const createdBy = (actor: KanbanActor) =>
  isAgent(actor)
    ? { createdByAgentId: actor.agentId }
    : { createdByUserId: actor.userId };

/** The attribution columns for a row this actor is editing. */
const lastEditedBy = (actor: KanbanActor) =>
  isAgent(actor)
    ? { lastEditedByAgentId: actor.agentId }
    : { lastEditedByUserId: actor.userId };

/**
 * Emits a board event. The acting Agent rides along on Agent-originated writes
 * so an event trigger does not re-fire on its own agent's work (see #267);
 * human writes carry no actor.
 */
const dispatch = (ctx: KanbanContext, event: WebhookEvent, data: unknown) =>
  dispatchEvent(
    ctx.orgId,
    ctx.workspaceId,
    event,
    data,
    isAgent(ctx.actor) ? { actorAgentId: ctx.actor.agentId } : undefined,
  );

/**
 * The card attributes a value-diff considers. Bookkeeping columns
 * (`updatedAt`, the `lastEditedBy*` attribution, `position`) are excluded —
 * every write touches them, so including them would make `changedFields`
 * meaningless. `id`, `createdAt`, and `createdBy*` are left in for
 * completeness but never differ between an old and new row.
 */
const CHANGED_FIELD_KEYS = [
  "title",
  "body",
  "labelIds",
  "assignees",
  "dueDate",
  "priority",
  "columnId",
] as const satisfies readonly (keyof CardRow)[];

/** The set-like fields compared order-insensitively, not by array equality. */
const SET_LIKE_FIELDS = new Set<string>(["labelIds", "assignees"]);

/** A field's value, reduced to a form where `===`-by-JSON is the right test. */
const comparableFieldValue = (key: string, value: unknown): unknown => {
  if (value === undefined || value === null) return value;
  if (key === "labelIds") return [...(value as string[])].sort();
  if (key === "assignees") {
    return (value as KanbanCardAssignee[])
      .map((assignee) => `${assignee.type}:${assignee.id}`)
      .sort();
  }
  if (value instanceof Date) return value.getTime();
  return value;
};

/**
 * The names of the fields whose values actually differ between the pre-write
 * and post-write row — a value-diff, not a report of which input keys were
 * supplied (see #622: an update that echoes a field back unchanged, or an
 * agent that resends `labelIds`/`assignees` in a different order, must not
 * report that field as changed).
 */
export const changedCardFields = (previous: CardRow, next: CardRow): string[] =>
  CHANGED_FIELD_KEYS.filter((key) => {
    const before = comparableFieldValue(key, previous[key]);
    const after = comparableFieldValue(key, next[key]);
    return SET_LIKE_FIELDS.has(key)
      ? JSON.stringify(before) !== JSON.stringify(after)
      : before !== after;
  });

/**
 * Announces a card write that may have changed its column. Emits
 * `card.moved` (with `previousColumnId`) only when the column actually
 * changed, always followed by `card.updated` — a within-column reorder or
 * a plain field edit emits `card.updated` alone.
 */
const dispatchCardWrite = (
  ctx: KanbanContext,
  row: CardRow,
  boardId: string,
  previousColumnId: string,
  changedFields: string[],
) => {
  if (previousColumnId !== row.columnId) {
    dispatch(ctx, "card.moved", { ...row, boardId, previousColumnId });
  }
  dispatch(ctx, "card.updated", { ...row, boardId, changedFields });
};

// --- Scope guards ---

/** The board-side condition every guard joins through: Workspace, then board. */
const withinScope = (scope: KanbanScope) =>
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
const requireColumn = async (
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

// --- Labels ---

/** The board's label IDs, or an empty list if the board has none. */
const boardLabelIds = async (
  database: Database,
  boardId: string,
): Promise<string[]> => {
  const rows = await database
    .select({ labels: kanbanBoardTable.labels })
    .from(kanbanBoardTable)
    .where(eq(kanbanBoardTable.id, boardId))
    .limit(1);

  return (rows[0]?.labels ?? []).map((label: { id: string }) => label.id);
};

/**
 * Rejects the write when it names a label the board does not have. Used where
 * the labels are chosen fresh (creating a card): there is nothing to
 * self-heal, so an unknown ID is a mistake worth surfacing.
 */
export const requireKnownLabelIds = async (
  database: Database,
  boardId: string,
  labelIds: string[] | undefined,
): Promise<void> => {
  if (!labelIds || labelIds.length === 0) return;
  const known = new Set(await boardLabelIds(database, boardId));
  if (!labelIds.every((id) => known.has(id))) {
    throw new ValidationError("Invalid label ID");
  }
};

/**
 * Drops the label IDs the board no longer has, keeping the rest in the order
 * submitted. Used where the labels come back from an existing card: it may be
 * holding a deleted label's ID that the editor never shows, so rejecting would
 * wedge the card while saving self-heals it.
 */
export const keepKnownLabelIds = async (
  database: Database,
  boardId: string,
  labelIds: string[],
): Promise<string[]> =>
  labelIds.length === 0
    ? labelIds
    : filterKnownLabelIds(labelIds, await boardLabelIds(database, boardId));

/**
 * Removes label IDs the board no longer has from every card on that board.
 * Board labels are an array on the board record and cards reference them by ID,
 * so deleting a label would otherwise leave cards holding an ID that resolves
 * to nothing. Only removes IDs — a card never gains a label here.
 */
export const pruneCardLabelsForBoard = async (
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

// --- Assignees ---

/**
 * Rejects assignees that cannot own a card here: a user must be a member of
 * the Organization (or a super admin, who has no membership row), and an Agent
 * must be visible in this Workspace — its own, plus the Shared Agents attached
 * to it (ADR-0007). That is the set the assignee picker offers and the set that
 * can actually run here.
 */
export const requireValidAssignees = async (
  database: Database,
  assignees: KanbanCardAssignee[] | undefined,
  scope: ScopeContext,
): Promise<void> => {
  if (!assignees || assignees.length === 0) return;

  const userIds = assignees.filter((a) => a.type === "user").map((a) => a.id);
  const agentIds = assignees.filter((a) => a.type === "agent").map((a) => a.id);

  const [members, superAdmins, agentRecords] = await Promise.all([
    userIds.length > 0
      ? database
          .select({ userId: organizationMemberTable.userId })
          .from(organizationMemberTable)
          .where(
            and(
              eq(organizationMemberTable.organizationId, scope.orgId),
              inArray(organizationMemberTable.userId, userIds),
            ),
          )
      : Promise.resolve([]),
    userIds.length > 0
      ? database
          .select({ id: user.id })
          .from(user)
          .where(and(eq(user.role, "admin"), inArray(user.id, userIds)))
      : Promise.resolve([]),
    listScopedByIds(database, "agent", agentIds, scope),
  ]);

  // Super admins may hold no org membership record, so the two sets combine.
  const validUserIds = new Set([
    ...members.map((m) => m.userId),
    ...superAdmins.map((a) => a.id),
  ]);
  if (validUserIds.size < userIds.length) {
    throw new ValidationError("Invalid user assignee");
  }
  if (agentRecords.length !== agentIds.length) {
    throw new ValidationError("Invalid agent assignee");
  }
};

// --- Positions ---

/** The tables ordered by a `position` float within a parent. */
type PositionedTable = typeof kanbanCardTable | typeof kanbanColumnTable;

/** One past the highest position in the group — the append-to-end slot. */
const nextPosition = async (
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

/** The position a card appended to the end of a column would take. */
const nextCardPosition = (
  executor: Executor,
  columnId: string,
): Promise<number> =>
  nextPosition(
    executor,
    kanbanCardTable,
    eq(kanbanCardTable.columnId, columnId),
  );

/** The position a column appended to the end of a board would take. */
export const nextColumnPosition = (
  executor: Executor,
  boardId: string,
): Promise<number> =>
  nextPosition(
    executor,
    kanbanColumnTable,
    eq(kanbanColumnTable.boardId, boardId),
  );

/**
 * Whole positions for a column's existing cards once one more is inserted just
 * after `afterIndex` — the renumbering that reopens the gaps after repeated
 * halving has closed them. The inserted card takes `afterIndex + 2`, the slot
 * this leaves free.
 */
export const rebalancedPositions = (
  cards: { id: string }[],
  afterIndex: number,
): { id: string; position: number }[] =>
  cards.map((card, index) => ({
    id: card.id,
    position: (index <= afterIndex ? index + 1 : index + 2) * 1.0,
  }));

/**
 * Where a card lands in a column, rebalancing the column first if the gap it
 * would take has collapsed. `afterCardId` is the card to sit behind: `null`
 * puts it at the head, `undefined` at the end.
 *
 * The single home for the board's ordering arithmetic — moving a card, copying
 * one, and appending one all resolve their position through here.
 */
export const placeCardInColumn = async (
  executor: Executor,
  input: {
    columnId: string;
    afterCardId: string | null | undefined;
    /** The card being moved, left out of the ordering it is re-entering. */
    excludeCardId?: string;
  },
): Promise<number> => {
  if (input.afterCardId === undefined) {
    return nextCardPosition(executor, input.columnId);
  }

  const cardsInColumn = await executor
    .select({ id: kanbanCardTable.id, position: kanbanCardTable.position })
    .from(kanbanCardTable)
    .where(eq(kanbanCardTable.columnId, input.columnId))
    .orderBy(asc(kanbanCardTable.position));

  const otherCards = cardsInColumn.filter(
    (card) => card.id !== input.excludeCardId,
  );

  let result: ReturnType<typeof calculateCardPosition>;
  try {
    result = calculateCardPosition(otherCards, input.afterCardId);
  } catch {
    throw new ValidationError("afterCardId not found in column");
  }

  if (!result.needsRebalance) return result.position;

  for (const card of rebalancedPositions(otherCards, result.afterIndex)) {
    await executor
      .update(kanbanCardTable)
      .set({ position: card.position, updatedAt: new Date() })
      .where(eq(kanbanCardTable.id, card.id));
  }
  return (result.afterIndex + 2) * 1.0;
};

// --- Card body ---

/**
 * The card row as it stands before a write — the pre-write side of the
 * `changedFields` value-diff, and (for a `bodyDiff` edit) what the diff
 * applies against.
 */
const currentCardRow = async (
  database: Executor,
  cardId: string,
): Promise<CardRow> => {
  const rows = await database
    .select()
    .from(kanbanCardTable)
    .where(eq(kanbanCardTable.id, cardId))
    .limit(1);

  const row = rows[0];
  if (!row) throw new NotFoundError("Card not found");
  return row;
};

/**
 * Applies a partial body edit. Search/replace pairs are applied in order and
 * each must match, so a diff written against a stale body fails loudly rather
 * than landing half-applied.
 */
export const applyBodyDiff = (body: string, diff: BodyDiff): string => {
  if (!Array.isArray(diff)) {
    return diff.mode === "append" ? body + diff.content : diff.content + body;
  }

  let next = body;
  for (const op of diff) {
    if (!next.includes(op.search)) {
      throw new ValidationError(
        `bodyDiff search string not found: "${op.search}"`,
      );
    }
    next = next.replace(op.search, op.replace);
  }
  return next;
};

// --- Card mutations ---

/** The columns a card write sets, from the fields the caller supplied. */
const cardValues = (input: CardInput, body: string | null | undefined) => ({
  ...(input.title !== undefined && { title: input.title }),
  ...(body !== undefined && { body }),
  ...(input.labelIds !== undefined && { labelIds: input.labelIds }),
  ...(input.assignees !== undefined && { assignees: input.assignees }),
  ...(input.dueDate !== undefined && {
    dueDate: input.dueDate ? new Date(input.dueDate) : null,
  }),
  ...(input.priority !== undefined && { priority: input.priority }),
});

/**
 * Creates a card at the end of a column. Labels are checked against the board
 * and assignees against the Workspace before anything is written.
 */
export const createCard = async (
  database: Database,
  ctx: KanbanContext,
  input: CardInput & { columnId: string; title: string },
): Promise<CardResult> => {
  const column = await requireColumn(database, ctx, input.columnId);
  await requireKnownLabelIds(database, column.boardId, input.labelIds);
  await requireValidAssignees(database, input.assignees, ctx);

  const position = await nextCardPosition(database, input.columnId);
  const now = new Date();

  const rows = await database
    .insert(kanbanCardTable)
    .values({
      id: nanoid(),
      columnId: input.columnId,
      title: input.title,
      labelIds: input.labelIds ?? [],
      assignees: input.assignees ?? [],
      priority: input.priority ?? "none",
      ...cardValues(input, input.body),
      position,
      ...createdBy(ctx.actor),
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  const card = rows[0];
  dispatch(ctx, "card.created", { ...card, boardId: column.boardId });
  return { card, boardId: column.boardId };
};

/**
 * Updates a card in place. Unknown label IDs are dropped rather than rejected
 * (the card may be carrying one the board has since deleted); an assignee who
 * cannot work here is rejected.
 */
export const updateCard = async (
  database: Database,
  ctx: KanbanContext,
  cardId: string,
  input: CardInput,
): Promise<CardResult> => {
  const card = await requireCard(database, ctx, cardId);
  const previous = await currentCardRow(database, cardId);

  const labelIds =
    input.labelIds === undefined
      ? undefined
      : await keepKnownLabelIds(database, card.boardId, input.labelIds);
  await requireValidAssignees(database, input.assignees, ctx);

  const body =
    input.bodyDiff === undefined
      ? input.body
      : applyBodyDiff(previous.body ?? "", input.bodyDiff);

  const rows = await database
    .update(kanbanCardTable)
    .set({
      ...cardValues(input, body),
      ...(labelIds !== undefined && { labelIds }),
      ...lastEditedBy(ctx.actor),
      updatedAt: new Date(),
    })
    .where(eq(kanbanCardTable.id, cardId))
    .returning();

  const record = rows[0];
  if (!record) throw new NotFoundError("Card not found");

  dispatch(ctx, "card.updated", {
    ...record,
    boardId: card.boardId,
    changedFields: changedCardFields(previous, record),
  });
  return { card: record, boardId: card.boardId };
};

/**
 * Moves a card within or between columns. Both the card and the target column
 * must be in scope, so a move never carries a card off its board on the HTTP
 * surface or out of the Workspace on the Tool surface.
 */
export const moveCard = async (
  database: Database,
  ctx: KanbanContext,
  input: { cardId: string; columnId: string; afterCardId: string | null },
): Promise<CardResult> => {
  const previous = await requireCard(database, ctx, input.cardId);
  const column = await requireColumn(database, ctx, input.columnId);

  const record = await database.transaction(async (tx) => {
    const position = await placeCardInColumn(tx, {
      columnId: input.columnId,
      afterCardId: input.afterCardId,
      excludeCardId: input.cardId,
    });

    const rows = await tx
      .update(kanbanCardTable)
      .set({
        columnId: input.columnId,
        position,
        ...lastEditedBy(ctx.actor),
        updatedAt: new Date(),
      })
      .where(eq(kanbanCardTable.id, input.cardId))
      .returning();

    return rows[0];
  });

  // A move only ever touches columnId and position (bookkeeping, excluded),
  // so the changedFields diff is this one comparison rather than a
  // `changedCardFields` call — `previous` here is a narrow `CardRef`
  // (from `requireCard`), not a full `CardRow`, and doesn't carry the other
  // fields a general diff would need.
  dispatchCardWrite(
    ctx,
    record,
    column.boardId,
    previous.columnId,
    previous.columnId !== record.columnId ? ["columnId"] : [],
  );
  return { card: record, boardId: column.boardId };
};

/**
 * Copies a card into a column on the same board, optionally with its comments.
 * The copy is attributed to whoever asked for it, not to the original author.
 */
export const copyCard = async (
  database: Database,
  ctx: KanbanContext,
  input: {
    cardId: string;
    columnId: string;
    /** `null`/omitted places the copy at the end of the column. */
    afterCardId?: string | null;
    includeComments?: boolean;
  },
): Promise<CardResult> => {
  const source = await requireCard(database, ctx, input.cardId);
  const target = await requireColumn(database, ctx, input.columnId);
  if (source.boardId !== target.boardId) {
    throw new ValidationError("Cross-board copy is not allowed");
  }

  const sourceRows = await database
    .select()
    .from(kanbanCardTable)
    .where(eq(kanbanCardTable.id, input.cardId))
    .limit(1);
  const sourceCard = sourceRows[0];

  const record = await database.transaction(async (tx) => {
    const position = await placeCardInColumn(tx, {
      columnId: input.columnId,
      afterCardId: input.afterCardId ?? undefined,
    });

    const newId = nanoid();
    const now = new Date();

    const rows = await tx
      .insert(kanbanCardTable)
      .values({
        id: newId,
        columnId: input.columnId,
        title: sourceCard.title,
        body: sourceCard.body,
        labelIds: sourceCard.labelIds,
        assignees: sourceCard.assignees,
        dueDate: sourceCard.dueDate,
        priority: sourceCard.priority,
        position,
        ...createdBy(ctx.actor),
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    if (input.includeComments) {
      const comments = await tx
        .select()
        .from(kanbanCardCommentTable)
        .where(eq(kanbanCardCommentTable.cardId, input.cardId))
        .orderBy(asc(kanbanCardCommentTable.createdAt));

      for (const comment of comments) {
        await tx.insert(kanbanCardCommentTable).values({
          id: nanoid(),
          cardId: newId,
          body: comment.body,
          ...createdBy(ctx.actor),
          createdAt: now,
          updatedAt: now,
        });
      }
    }

    return rows[0];
  });

  dispatch(ctx, "card.created", { ...record, boardId: source.boardId });
  return { card: record, boardId: source.boardId };
};

/** Removes an already-resolved card and announces where it had been. */
const removeCard = async (
  database: Database,
  ctx: KanbanContext,
  card: CardRef,
): Promise<void> => {
  await database.delete(kanbanCardTable).where(eq(kanbanCardTable.id, card.id));

  dispatch(ctx, "card.deleted", {
    cardId: card.id,
    boardId: card.boardId,
    columnId: card.columnId,
  });
};

/** Deletes a card and announces it. Returns where the card had been. */
export const deleteCard = async (
  database: Database,
  ctx: KanbanContext,
  cardId: string,
): Promise<CardRef> => {
  const card = await requireCard(database, ctx, cardId);
  await removeCard(database, ctx, card);
  return card;
};

/**
 * Deletes several cards. Every card is resolved before any is removed, so a
 * batch naming one card that is out of scope deletes none of them.
 */
export const deleteCards = async (
  database: Database,
  ctx: KanbanContext,
  cardIds: string[],
): Promise<CardRef[]> => {
  const cards: CardRef[] = [];
  for (const cardId of cardIds) {
    try {
      cards.push(await requireCard(database, ctx, cardId));
    } catch (error) {
      if (!(error instanceof NotFoundError)) throw error;
      // Names the card that failed — a batch caller cannot tell otherwise.
      throw new NotFoundError(`Card not found: ${cardId}`);
    }
  }

  for (const card of cards) await removeCard(database, ctx, card);
  return cards;
};

/** The label edit a bulk update applies: a replacement, or adds and removes. */
export type BulkLabelEdit = {
  labelIds?: string[];
  addLabelIds?: string[];
  removeLabelIds?: string[];
};

/** What a bulk update did, per card, in the order the cards were given. */
export type BulkUpdateOutcome = {
  cardId: string;
  success: boolean;
  error?: string;
};

/**
 * Applies one set of values to many cards in a single transaction. Cards that
 * are out of scope are reported per card rather than failing the batch, but a
 * bad assignee or an unreachable target column stops the whole call — those
 * are wrong for every card, not just one.
 *
 * Labels follow the update rule rather than the create rule: unknown IDs are
 * dropped, not rejected. A bulk edit works over cards that already exist, so
 * the same self-healing that saves a single card applies here — and refusing
 * thirty cards over one stale ID none of them can show would be worse.
 *
 * With `columnId`, the cards are appended to that column in the order given.
 */
export const bulkUpdateCards = async (
  database: Database,
  ctx: KanbanContext,
  input: BulkLabelEdit & {
    cardIds: string[];
    columnId?: string;
    assignees?: KanbanCardAssignee[];
    priority?: KanbanCardPriority;
    dueDate?: string | null;
  },
): Promise<BulkUpdateOutcome[]> => {
  if (input.columnId) await requireColumn(database, ctx, input.columnId);
  await requireValidAssignees(database, input.assignees, ctx);

  const outcomes = new Map<string, BulkUpdateOutcome>();
  const cards: CardRef[] = [];
  for (const cardId of input.cardIds) {
    try {
      cards.push(await requireCard(database, ctx, cardId));
      outcomes.set(cardId, { cardId, success: true });
    } catch (error) {
      // Only an out-of-scope card is reported per card; a failed query fails
      // the batch rather than reading as thirty missing cards.
      if (!(error instanceof NotFoundError)) throw error;
      outcomes.set(cardId, {
        cardId,
        success: false,
        error: "Card not found",
      });
    }
  }

  if (cards.length === 0) return input.cardIds.map((id) => outcomes.get(id)!);

  // Additive and subtractive label edits build on what each card already
  // holds, so those rows are read before the write.
  const editsLabels =
    input.labelIds !== undefined ||
    input.addLabelIds !== undefined ||
    input.removeLabelIds !== undefined;
  const currentLabels = new Map<string, string[]>();
  if (input.addLabelIds !== undefined || input.removeLabelIds !== undefined) {
    const rows = await database
      .select({ id: kanbanCardTable.id, labelIds: kanbanCardTable.labelIds })
      .from(kanbanCardTable)
      .where(
        inArray(
          kanbanCardTable.id,
          cards.map((card) => card.id),
        ),
      );
    for (const row of rows) currentLabels.set(row.id, row.labelIds);
  }

  // The cards may span boards, so each board's labels are fetched once and
  // reused for every card on it.
  const knownLabels = new Map<string, string[]>();
  const labelsOf = async (boardId: string): Promise<string[]> => {
    const cached = knownLabels.get(boardId);
    if (cached) return cached;
    const labels = await boardLabelIds(database, boardId);
    knownLabels.set(boardId, labels);
    return labels;
  };

  const basePosition = input.columnId
    ? await nextCardPosition(database, input.columnId)
    : 0;

  const updated = await database.transaction(async (tx) => {
    const records: { card: CardRef; row: CardRow; previous: CardRow }[] = [];

    for (const [index, card] of cards.entries()) {
      // The value-diff each card's `card.updated` event carries is computed
      // against the row as it stood right before this write. `card` (from
      // `requireCard`) only carries id/columnId/boardId, not the field values
      // a diff needs, so this is a genuine extra read rather than reuse.
      const previous = await currentCardRow(tx, card.id);

      const labelIds = editsLabels
        ? filterKnownLabelIds(
            resolveBulkLabels(input, currentLabels.get(card.id) ?? []),
            await labelsOf(card.boardId),
          )
        : undefined;

      const rows = await tx
        .update(kanbanCardTable)
        .set({
          ...(input.columnId !== undefined && {
            columnId: input.columnId,
            position: basePosition + index,
          }),
          ...(labelIds !== undefined && { labelIds }),
          ...(input.assignees !== undefined && { assignees: input.assignees }),
          ...(input.priority !== undefined && { priority: input.priority }),
          ...(input.dueDate !== undefined && {
            dueDate: input.dueDate ? new Date(input.dueDate) : null,
          }),
          ...lastEditedBy(ctx.actor),
          updatedAt: new Date(),
        })
        .where(eq(kanbanCardTable.id, card.id))
        .returning();

      records.push({ card, row: rows[0], previous });
    }
    return records;
  });

  for (const { card, row, previous } of updated) {
    dispatchCardWrite(
      ctx,
      row,
      card.boardId,
      card.columnId,
      changedCardFields(previous, row),
    );
  }

  return input.cardIds.map((id) => outcomes.get(id)!);
};

/** The label list a bulk edit asks for, before it is checked against the board. */
const resolveBulkLabels = (
  edit: BulkLabelEdit,
  current: string[],
): string[] => {
  if (edit.labelIds !== undefined) return edit.labelIds;
  let next = [...new Set([...current, ...(edit.addLabelIds ?? [])])];
  if (edit.removeLabelIds) {
    next = next.filter((id) => !edit.removeLabelIds!.includes(id));
  }
  return next;
};

// --- Comments ---

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
