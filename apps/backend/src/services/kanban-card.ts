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
import { oneRow } from "../db/one-row.ts";

export type CardResult = { card: CardRow; boardId: string };

export type CardInput = {
  title?: string;
  body?: string | null;
  bodyDiff?: BodyDiff;
  labelIds?: string[];
  assignees?: KanbanCardAssignee[];
  dueDate?: string | null;
  priority?: KanbanCardPriority;
};

export type BodyDiff =
  | { search: string; replace: string }[]
  | { mode: "append" | "prepend"; content: string };

const dispatch = (ctx: KanbanContext, payload: EventTriggerEventPayload) =>
  dispatchEvent(ctx.orgId, ctx.workspaceId, payload);

const CHANGED_FIELD_KEYS = [
  "title",
  "body",
  "labelIds",
  "assignees",
  "dueDate",
  "priority",
  "columnId",
] as const satisfies readonly (keyof CardRow)[];

const SET_LIKE_FIELDS = new Set<string>(["labelIds", "assignees"]);

const comparableFieldValue = (key: string, value: unknown): unknown => {
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

export const changedCardFields = (previous: CardRow, next: CardRow): string[] =>
  CHANGED_FIELD_KEYS.filter((key) => {
    const before = comparableFieldValue(key, previous[key]);
    const after = comparableFieldValue(key, next[key]);
    return SET_LIKE_FIELDS.has(key)
      ? JSON.stringify(before) !== JSON.stringify(after)
      : before !== after;
  });

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

export const keepKnownLabelIds = async (
  database: Database,
  boardId: string,
  labelIds: string[],
): Promise<string[]> =>
  labelIds.length === 0
    ? labelIds
    : filterKnownLabelIds(labelIds, await boardLabelIds(database, boardId));

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

const nextCardPosition = (
  executor: Executor,
  columnId: string,
): Promise<number> =>
  nextPosition(
    executor,
    kanbanCardTable,
    eq(kanbanCardTable.columnId, columnId),
  );

export const rebalancedPositions = (
  cards: { id: string }[],
  afterIndex: number,
): { id: string; position: number }[] =>
  cards.map((card, index) => ({
    id: card.id,
    position: (index <= afterIndex ? index + 1 : index + 2) * 1.0,
  }));

export const calculateCardPosition = (
  otherCards: { id: string; position: number }[],
  afterCardId: string | null,
): { position: number; needsRebalance: boolean; afterIndex: number } => {
  if (afterCardId === null) {
    const [first] = otherCards;
    const position = first ? first.position / 2 : 1.0;
    return { position, needsRebalance: false, afterIndex: -1 };
  }

  const afterIndex = otherCards.findIndex((card) => card.id === afterCardId);
  const anchor = otherCards[afterIndex];
  if (!anchor) {
    throw new ValidationError("afterCardId not found in column");
  }

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

export const placeCardInColumn = async (
  executor: Executor,
  input: {
    columnId: string;
    afterCardId: string | null | undefined;
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

    const row = oneRow(rows);
    await recordCardCreated(tx, ctx, row);
    return row;
  });

  dispatch(ctx, {
    event: "card.created",
    data: { ...card, boardId: column.boardId },
  });
  return { card, boardId: column.boardId };
};

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
    if (!row) {
      throw new ConflictError(
        "Card is no longer in the expected column; re-read it before moving it",
      );
    }

    if (previous.columnId !== row.columnId) {
      await recordCardMoved(tx, ctx, row.id, previous.columnId, row.columnId);
    }
    return row;
  });

  dispatchCardWrite(
    ctx,
    record,
    column.boardId,
    previous.columnId,
    previous.columnId !== record.columnId ? ["columnId"] : [],
  );
  return { card: record, boardId: column.boardId };
};

export const copyCard = async (
  database: Database,
  ctx: KanbanContext,
  input: {
    cardId: string;
    columnId: string;
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
  if (!sourceCard) throw new NotFoundError("Card not found");

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

    const row = oneRow(rows);
    await recordCardCreated(tx, ctx, row);

    return row;
  });

  dispatch(ctx, {
    event: "card.created",
    data: { ...record, boardId: source.boardId },
  });
  return { card: record, boardId: source.boardId };
};

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

export const deleteCard = async (
  database: Database,
  ctx: KanbanContext,
  cardId: string,
): Promise<CardRef> => {
  const card = await requireCard(database, ctx, cardId);
  await removeCard(database, ctx, card);
  return card;
};

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
      throw new NotFoundError(`Card not found: ${cardId}`);
    }
  }

  for (const card of cards) await removeCard(database, ctx, card);
  return cards;
};

export type BulkLabelEdit = {
  labelIds?: string[];
  addLabelIds?: string[];
  removeLabelIds?: string[];
};

export type BulkUpdateOutcome = {
  cardId: string;
  success: boolean;
  error?: string;
};

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
  const outcomeOf = (id: string): BulkUpdateOutcome => {
    const outcome = outcomes.get(id);
    if (!outcome) throw new Error(`Card '${id}' has no outcome`);
    return outcome;
  };
  const cards: CardRef[] = [];
  for (const cardId of input.cardIds) {
    try {
      cards.push(await requireCard(database, ctx, cardId));
      outcomes.set(cardId, { cardId, success: true });
    } catch (error) {
      if (!(error instanceof NotFoundError)) throw error;
      outcomes.set(cardId, {
        cardId,
        success: false,
        error: "Card not found",
      });
    }
  }

  if (cards.length === 0) return input.cardIds.map(outcomeOf);

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
      if (!row) throw new NotFoundError("Card not found");
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

  return input.cardIds.map(outcomeOf);
};

const resolveBulkLabels = (
  edit: BulkLabelEdit,
  current: string[],
): string[] => {
  if (edit.labelIds !== undefined) return edit.labelIds;
  let next = [...new Set([...current, ...(edit.addLabelIds ?? [])])];
  const { removeLabelIds } = edit;
  if (removeLabelIds) {
    next = next.filter((id) => !removeLabelIds.includes(id));
  }
  return next;
};

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
