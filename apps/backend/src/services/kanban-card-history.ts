import { and, desc, eq, inArray, notInArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import type {
  KanbanCardHistoryChange,
  KanbanCardHistoryRef,
} from "@platypus/schemas";
import { KANBAN_CARD_HISTORY_LIMIT } from "@platypus/schemas";
import {
  kanbanBoard as kanbanBoardTable,
  kanbanColumn as kanbanColumnTable,
  kanbanCardHistory as kanbanCardHistoryTable,
  agent as agentTable,
} from "../db/schema.ts";
import { user } from "../db/auth-schema.ts";
import {
  isAgent,
  isoOrNull,
  requireCard,
  type CardRow,
  type Database,
  type Executor,
  type KanbanActor,
  type KanbanContext,
  type KanbanScope,
} from "./kanban-shared.ts";

/**
 * A Card history entry as stored. The actor mirrors the Card's own
 * `lastEditedBy*` columns, so an entry and the Card can never disagree about
 * who wrote it.
 */
type CardHistoryRow = typeof kanbanCardHistoryTable.$inferSelect;

/** A history entry with its actor's display name resolved. */
export type CardHistoryEntry = CardHistoryRow & { actorName: string | null };

/** The attribution columns for a history entry this actor is causing. */
const historyActor = (actor: KanbanActor) =>
  isAgent(actor)
    ? { actorAgentId: actor.agentId }
    : { actorUserId: actor.userId };

/**
 * The board's Labels by id, for snapshotting names into an entry. A Card can
 * carry a Label id the board has since dropped, in which case the id stands in
 * for the name — an unreadable entry is still better than a missing one.
 */
const boardLabelNames = async (
  executor: Executor,
  boardId: string,
): Promise<Map<string, string>> => {
  const rows = await executor
    .select({ labels: kanbanBoardTable.labels })
    .from(kanbanBoardTable)
    .where(eq(kanbanBoardTable.id, boardId))
    .limit(1);

  return new Map(
    (rows[0]?.labels ?? []).map((label) => [label.id, label.name]),
  );
};

/** Column names by id, for the same reason. */
const columnNames = async (
  executor: Executor,
  columnIds: string[],
): Promise<Map<string, string>> => {
  const ids = [...new Set(columnIds)];
  if (ids.length === 0) return new Map();

  const rows = await executor
    .select({ id: kanbanColumnTable.id, name: kanbanColumnTable.name })
    .from(kanbanColumnTable)
    .where(inArray(kanbanColumnTable.id, ids))
    .limit(ids.length);

  return new Map(rows.map((row) => [row.id, row.name]));
};

const ref = (id: string, names: Map<string, string>): KanbanCardHistoryRef => ({
  id,
  name: names.get(id) ?? id,
});

/**
 * Turns a value-diff into the changes an entry records. Driven by the field
 * names `changedCardFields` produced, so the history and the `card.updated`
 * event can never disagree about what moved.
 *
 * `body` is the deliberate exception: recorded as having changed, never with
 * its text (ADR-0024). Label and Column values carry the name as it stood
 * here, which is what keeps an entry readable after a rename or a deletion.
 */
const historyChanges = async (
  executor: Executor,
  boardId: string,
  changedFields: string[],
  previous: CardRow,
  next: CardRow,
): Promise<KanbanCardHistoryChange[]> => {
  const changes: KanbanCardHistoryChange[] = [];

  const labels = changedFields.includes("labelIds")
    ? await boardLabelNames(executor, boardId)
    : new Map<string, string>();
  const columns = changedFields.includes("columnId")
    ? await columnNames(executor, [previous.columnId, next.columnId])
    : new Map<string, string>();

  for (const field of changedFields) {
    switch (field) {
      case "title":
        changes.push({ field, before: previous.title, after: next.title });
        break;
      case "body":
        changes.push({ field });
        break;
      case "priority":
        changes.push({
          field,
          before: previous.priority,
          after: next.priority,
        });
        break;
      case "dueDate":
        changes.push({
          field,
          before: isoOrNull(previous.dueDate),
          after: isoOrNull(next.dueDate),
        });
        break;
      case "assignees":
        changes.push({
          field,
          before: previous.assignees,
          after: next.assignees,
        });
        break;
      case "labelIds":
        changes.push({
          field,
          before: previous.labelIds.map((id) => ref(id, labels)),
          after: next.labelIds.map((id) => ref(id, labels)),
        });
        break;
      case "columnId":
        changes.push({
          field,
          before: ref(previous.columnId, columns),
          after: ref(next.columnId, columns),
        });
        break;
    }
  }

  return changes;
};

/**
 * Drops everything past the cap for one Card, in the caller's transaction.
 * Trimming inline is what makes the bound an invariant rather than something
 * a sweep job eventually restores.
 */
const trimCardHistory = async (
  executor: Executor,
  cardId: string,
): Promise<void> => {
  // One statement rather than a read then a write: the newest N are chosen by
  // a subquery, so a write costs no extra round trip to stay within the cap.
  const newest = executor
    .select({ id: kanbanCardHistoryTable.id })
    .from(kanbanCardHistoryTable)
    .where(eq(kanbanCardHistoryTable.cardId, cardId))
    .orderBy(
      desc(kanbanCardHistoryTable.createdAt),
      desc(kanbanCardHistoryTable.id),
    )
    .limit(KANBAN_CARD_HISTORY_LIMIT);

  await executor
    .delete(kanbanCardHistoryTable)
    .where(
      and(
        eq(kanbanCardHistoryTable.cardId, cardId),
        notInArray(kanbanCardHistoryTable.id, newest),
      ),
    );
};

/**
 * Appends one entry for one write, and trims to the cap — both in the caller's
 * transaction, never from `dispatch()`. `dispatchEvent` returns `void` and is
 * unawaited, so an entry written from there would land outside the transaction
 * and a rolled-back write would still be recorded (ADR-0024).
 *
 * An `updated` write whose diff is empty appends nothing, which is how a
 * within-column reorder — `position` only, and `position` is not a tracked
 * field — leaves no trace.
 */
const writeHistoryEntry = async (
  executor: Executor,
  ctx: KanbanContext,
  cardId: string,
  kind: "created" | "updated",
  changes: KanbanCardHistoryChange[],
): Promise<void> => {
  await executor.insert(kanbanCardHistoryTable).values({
    id: nanoid(),
    cardId,
    kind,
    changes,
    ...historyActor(ctx.actor),
    createdAt: new Date(),
  });

  await trimCardHistory(executor, cardId);
};

/** The entry a Card's creation leaves: it came into existence in a Column. */
export const recordCardCreated = async (
  executor: Executor,
  ctx: KanbanContext,
  card: CardRow,
): Promise<void> => {
  const names = await columnNames(executor, [card.columnId]);
  await writeHistoryEntry(executor, ctx, card.id, "created", [
    { field: "columnId", before: null, after: ref(card.columnId, names) },
  ]);
};

/** The entry a Column change leaves, for a caller that knows only the move. */
export const recordCardMoved = async (
  executor: Executor,
  ctx: KanbanContext,
  cardId: string,
  previousColumnId: string,
  nextColumnId: string,
): Promise<void> => {
  const names = await columnNames(executor, [previousColumnId, nextColumnId]);
  await writeHistoryEntry(executor, ctx, cardId, "updated", [
    {
      field: "columnId",
      before: ref(previousColumnId, names),
      after: ref(nextColumnId, names),
    },
  ]);
};

export const recordCardHistory = async (
  executor: Executor,
  ctx: KanbanContext,
  input: {
    boardId: string;
    previous: CardRow;
    next: CardRow;
    /** What `changedCardFields` found. */
    changedFields: string[];
  },
): Promise<void> => {
  const changes = await historyChanges(
    executor,
    input.boardId,
    input.changedFields,
    input.previous,
    input.next,
  );

  if (changes.length === 0) return;

  await writeHistoryEntry(executor, ctx, input.next.id, "updated", changes);
};

/**
 * A Card's history, newest first. Capped at the same limit the writes trim to,
 * so a caller never has to page and the read is bounded by construction.
 */
export const listCardHistory = async (
  database: Database,
  scope: KanbanScope,
  cardId: string,
): Promise<CardHistoryEntry[]> => {
  await requireCard(database, scope, cardId);

  const rows = await database
    .select()
    .from(kanbanCardHistoryTable)
    .where(eq(kanbanCardHistoryTable.cardId, cardId))
    .orderBy(
      desc(kanbanCardHistoryTable.createdAt),
      desc(kanbanCardHistoryTable.id),
    )
    .limit(KANBAN_CARD_HISTORY_LIMIT);

  const userIds = new Set<string>();
  const agentIds = new Set<string>();
  for (const row of rows) {
    if (row.actorUserId) userIds.add(row.actorUserId);
    if (row.actorAgentId) agentIds.add(row.actorAgentId);
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

  // A deleted User or Agent leaves the entry standing with no name — what
  // changed is still the useful part, and the FK is `set null` for exactly
  // this reason.
  return rows.map((row) => ({
    ...row,
    actorName: row.actorUserId
      ? (userMap.get(row.actorUserId) ?? null)
      : row.actorAgentId
        ? (agentMap.get(row.actorAgentId) ?? null)
        : null,
  }));
};
