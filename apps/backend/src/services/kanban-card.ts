import { and, asc, eq, inArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import type {
  EventTriggerEventPayload,
  KanbanCardAssignee,
  KanbanCardPriority,
} from "@platypus/schemas";
import {
  kanbanBoard as kanbanBoardTable,
  kanbanCard as kanbanCardTable,
  kanbanCardComment as kanbanCardCommentTable,
  organizationMember as organizationMemberTable,
} from "../db/schema.ts";
import { user } from "../db/auth-schema.ts";
import { ConflictError, NotFoundError, ValidationError } from "../errors.ts";
import type { ScopeContext } from "../scope.ts";
import { dispatchEvent } from "./event-dispatch.ts";
import { listScopedByIds } from "./scoped-resource.ts";
import { filterKnownLabelIds } from "../utils/kanban-labels.ts";
import {
  createdBy,
  lastEditedBy,
  nextPosition,
  requireCard,
  requireColumn,
  type CardRef,
  type CardRow,
  type Database,
  type Executor,
  type KanbanContext,
  type KanbanScope,
} from "./kanban-shared.ts";
import {
  recordCardCreated,
  recordCardHistory,
  recordCardMoved,
} from "./kanban-card-history.ts";

/**
 * A written card and the board it is on. The board comes back with it because
 * a card row does not name its board — only its column — and both surfaces
 * need it: to announce the change, and to link to it.
 */
export type CardResult = { card: CardRow; boardId: string };

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

/**
 * Emits a board event. Causation is ambient run context (ADR-0022), read by the
 * dispatcher rather than named by the writer, so the acting Agent is not
 * volunteered here — whether this write re-fires an Event Trigger is decided by
 * the chain of Agents the run established, not by this helper.
 */
const dispatch = (ctx: KanbanContext, payload: EventTriggerEventPayload) =>
  dispatchEvent(ctx.orgId, ctx.workspaceId, payload);

// --- Change detection ---

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
  // A Card with no description stores `null`, but a form bound to an empty
  // editor sends `""`. They mean the same thing, so they must compare equal —
  // otherwise saving an unrelated field from an open Card reports a
  // description edit nobody made.
  if (key === "body" && value === "") return null;
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
    dispatch(ctx, {
      event: "card.moved",
      data: { ...row, boardId, previousColumnId },
    });
  }
  dispatch(ctx, {
    event: "card.updated",
    data: { ...row, boardId, changedFields },
  });
};

// --- Label validation ---

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
 * The slot a card takes when it sits behind `afterCardId` (`null` = the head),
 * plus whether the gap it lands in has been halved so thin that the column
 * must be renumbered first.
 *
 * `otherCards` is the column in ascending position order, without the card
 * being placed.
 */
export const calculateCardPosition = (
  otherCards: { id: string; position: number }[],
  afterCardId: string | null,
): { position: number; needsRebalance: boolean; afterIndex: number } => {
  if (afterCardId === null) {
    const position = otherCards.length === 0 ? 1.0 : otherCards[0].position / 2;
    return { position, needsRebalance: false, afterIndex: -1 };
  }

  const afterIndex = otherCards.findIndex((card) => card.id === afterCardId);
  if (afterIndex === -1) {
    throw new ValidationError("afterCardId not found in column");
  }

  const anchor = otherCards[afterIndex];
  const next = otherCards[afterIndex + 1];
  if (!next) {
    return {
      position: anchor.position + 1.0,
      needsRebalance: false,
      afterIndex,
    };
  }

  return {
    position: (anchor.position + next.position) / 2,
    needsRebalance: next.position - anchor.position < 0.001,
    afterIndex,
  };
};

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

  const result = calculateCardPosition(otherCards, input.afterCardId);

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

  // The insert and its history entry share a transaction so the two can never
  // disagree — the reason the entry is not written from `dispatch()`.
  const card = await database.transaction(async (tx) => {
    const rows = await tx
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

    const row = rows[0];
    await recordCardCreated(tx, ctx, row);
    return row;
  });

  dispatch(ctx, {
    event: "card.created",
    data: { ...card, boardId: column.boardId },
  });
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

  const record = await database.transaction(async (tx) => {
    const rows = await tx
      .update(kanbanCardTable)
      .set({
        ...cardValues(input, body),
        ...(labelIds !== undefined && { labelIds }),
        ...lastEditedBy(ctx.actor),
        updatedAt: new Date(),
      })
      .where(eq(kanbanCardTable.id, cardId))
      .returning();

    const row = rows[0];
    if (!row) throw new NotFoundError("Card not found");

    await recordCardHistory(tx, ctx, {
      boardId: card.boardId,
      previous,
      next: row,
      changedFields: changedCardFields(previous, row),
    });
    return row;
  });

  dispatch(ctx, {
    event: "card.updated",
    data: {
      ...record,
      boardId: card.boardId,
      changedFields: changedCardFields(previous, record),
    },
  });
  return { card: record, boardId: card.boardId };
};

/**
 * Moves a card within or between columns. Both the card and the target column
 * must be in scope, so a move never carries a card off its board on the HTTP
 * surface or out of the Workspace on the Tool surface.
 *
 * `expectedColumnId` makes the move conditional: it applies only while the card
 * is still in that column, so a caller working from a stale read cannot
 * silently undo a move someone else made in the meantime. It is a predicate on
 * the UPDATE rather than a check against `previous`, because `previous` is read
 * before the transaction opens — comparing against it would catch a stale
 * caller but still let two concurrent writers both pass and the later one win,
 * which is the race worth closing.
 */
export const moveCard = async (
  database: Database,
  ctx: KanbanContext,
  input: {
    cardId: string;
    columnId: string;
    afterCardId: string | null;
    expectedColumnId?: string;
  },
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
      .where(
        input.expectedColumnId === undefined
          ? eq(kanbanCardTable.id, input.cardId)
          : and(
              eq(kanbanCardTable.id, input.cardId),
              eq(kanbanCardTable.columnId, input.expectedColumnId),
            ),
      )
      .returning();

    const row = rows[0];
    // Thrown rather than returned so the transaction rolls back:
    // `placeCardInColumn` may already have renumbered the target column on its
    // rebalance path, and committing that alongside a move that did not happen
    // would reorder the board on a refused write.
    //
    // The message deliberately does not say where the card is now. Handing the
    // winning writer's state back to the loser invites an immediate
    // re-assertion of the stale move; making the caller re-read forces a fresh
    // look at the board that changed underneath it.
    if (!row) {
      throw new ConflictError(
        "Card is no longer in the expected column; re-read it before moving it",
      );
    }

    // A move only ever touches columnId and position, so the entry is built
    // from the one comparison rather than a full-row diff — the same reason
    // the dispatch below computes its `changedFields` by hand. A within-column
    // reorder changes no tracked field and leaves no entry.
    if (previous.columnId !== row.columnId) {
      await recordCardMoved(tx, ctx, row.id, previous.columnId, row.columnId);
    }
    return row;
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

    // The copy's history starts at the copy: it is a new Card, and the
    // source's past is not its own.
    await recordCardCreated(tx, ctx, rows[0]);

    return rows[0];
  });

  dispatch(ctx, {
    event: "card.created",
    data: { ...record, boardId: source.boardId },
  });
  return { card: record, boardId: source.boardId };
};

/** Removes an already-resolved card and announces where it had been. */
const removeCard = async (
  database: Database,
  ctx: KanbanContext,
  card: CardRef,
): Promise<void> => {
  await database.delete(kanbanCardTable).where(eq(kanbanCardTable.id, card.id));

  dispatch(ctx, {
    event: "card.deleted",
    data: {
      cardId: card.id,
      boardId: card.boardId,
      columnId: card.columnId,
    },
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
    const records: {
      card: CardRef;
      row: CardRow;
      previous: CardRow;
      changedFields: string[];
    }[] = [];

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

      const row = rows[0];
      // Computed here rather than after the transaction: the history entry
      // needs it inside, and one computation keeps the entry and the event
      // reporting the same diff.
      const fields = changedCardFields(previous, row);

      await recordCardHistory(tx, ctx, {
        boardId: card.boardId,
        previous,
        next: row,
        changedFields: fields,
      });

      records.push({ card, row, previous, changedFields: fields });
    }
    return records;
  });

  for (const { card, row, changedFields } of updated) {
    dispatchCardWrite(ctx, row, card.boardId, card.columnId, changedFields);
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

// --- Card reads ---

/** The whole card, with the board it is on — or `NotFoundError` out of scope. */
export const getCard = async (
  database: Database,
  scope: KanbanScope,
  cardId: string,
): Promise<CardResult> => {
  const card = await requireCard(database, scope, cardId);
  return {
    card: await currentCardRow(database, cardId),
    boardId: card.boardId,
  };
};
