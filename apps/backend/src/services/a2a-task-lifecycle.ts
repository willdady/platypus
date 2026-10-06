import {
  and,
  eq,
  getTableColumns,
  isNotNull,
  isNull,
  ne,
  or,
} from "drizzle-orm";
import type { Task } from "@a2a-js/sdk";
import { db } from "../index.ts";
import {
  a2aPushConfig as a2aPushConfigTable,
  a2aTask as a2aTaskTable,
  chat as chatTable,
  type A2aTaskEndState,
} from "../db/schema.ts";
import { logger } from "../logger.ts";
import { cancelRun } from "../runs/run-cancel.ts";
import type { RunStatus } from "../runs/types.ts";
import type { ChatClaimTx } from "../runs/sinks/chat-sink.ts";
import {
  bareReading,
  currentTurnId,
  deriveStatus,
  END_OF_RUN,
  findTokenTaskReading,
  firstReply,
  readingOf,
  readWithStatus,
  recordedStatus,
  TERMINAL_TASK_STATES,
  type Executor,
  type TaskReading,
  type TaskRow,
  type TaskStatus,
} from "./a2a-task-state.ts";
import { pushRecordedEnd } from "./a2a-push.ts";

/**
 * The A2A Task lifecycle (ADR-0032, ADR-0034): submitted → working →
 * completed, failed or canceled. Every write of a Task's end is made here,
 * and so is every decision that a push is owed; `a2a-push.ts` only delivers
 * an end already recorded.
 *
 * A Task's end is recorded once, and the first end recorded stands, with the
 * reply it read: a later end, a cancel, a regenerate or a delete changes
 * nothing the Task reads. It is recorded by whichever comes first:
 *
 * - the run's terminal transaction (`endTurnIn`), so no claim of the Chat's
 *   next turn sees the Chat ended and the Task not (#1309);
 * - the run's end, once committed (`turnEnded`), or the end of a run that
 *   died, found as the next turn claims its Chat or by the recovery sweep;
 * - a cancel (`cancelTask`), claimed only while the Task's turn still runs;
 * - a read: until it is recorded, an end the read model derives could change
 *   with what the Owner does in the Chat, so a read through here records it.
 *
 * An end recorded here is pushed; one only committed elsewhere is pushed by
 * the next `turnEnded` in its Chat, or by `sweepMissedEnds`.
 */

/**
 * Records `state` as how the turn answering `messageId` ended, on its Task if
 * it has one, with the reply it wrote and the time. The first end recorded
 * stands, and with it its reply. Answers with the Task as recorded, if it
 * recorded. Pushes nothing: in a transaction, the end is not yet committed.
 */
const writeEnd = async (
  executor: Executor,
  chatId: string,
  messageId: string,
  state: A2aTaskEndState,
): Promise<TaskRow | undefined> => {
  const replyId = (await firstReply(chatId, messageId, executor)) ?? null;
  const [recorded] = await executor
    .update(a2aTaskTable)
    .set({ state, replyId, statusAt: new Date() })
    .where(
      and(
        eq(a2aTaskTable.chatId, chatId),
        eq(a2aTaskTable.messageId, messageId),
        isNull(a2aTaskTable.state),
      ),
    )
    .returning();
  return recorded;
};

/**
 * `writeEnd`, committed at once. An end it records is pushed, whoever
 * noticed it.
 */
const recordEnd = async (
  chatId: string,
  messageId: string,
  state: A2aTaskEndState,
): Promise<TaskRow | undefined> => {
  const recorded = await writeEnd(db, chatId, messageId, state);
  if (recorded) void pushRecordedEnd(recorded);
  return recorded;
};

/**
 * Records how the turn answering `turnId` ended with `status`, in `tx`: the
 * transaction its Chat's terminal status is written in, so no claim of the
 * next turn reads the Chat ended and the Task not (#1309). A status that is
 * no end records nothing. Pushes nothing; `turnEnded` pushes once `tx` has
 * committed.
 */
export const endTurnIn = async (
  tx: ChatClaimTx,
  chatId: string,
  turnId: string,
  status: RunStatus,
): Promise<TaskRow | undefined> => {
  const state = END_OF_RUN[status];
  return state ? writeEnd(tx, chatId, turnId, state) : undefined;
};

// ------------------------------------------------------------ Reconciling reads

/**
 * Records `state` on `task`, and answers with the end that stands: this one,
 * or one recorded first.
 */
const settle = async (
  task: TaskRow,
  state: A2aTaskEndState,
): Promise<TaskStatus> => {
  const recorded = await recordEnd(task.chatId, task.messageId, state);
  if (recorded) return recordedStatus({ ...recorded, state });
  const [row] = await db
    .select()
    .from(a2aTaskTable)
    .where(eq(a2aTaskTable.id, task.id))
    .limit(1);
  return recordedStatus({ ...(row ?? task), state: row?.state ?? state });
};

/**
 * The Task's status, as the read model derives it. An end it derives that is
 * not yet recorded is recorded here, so it stands once the Chat moves on.
 */
export const statusOf = async (task: TaskReading): Promise<TaskStatus> => {
  const derived = deriveStatus(task);
  return "unrecordedEnd" in derived
    ? settle(task, derived.unrecordedEnd)
    : derived.status;
};

/**
 * A Task, read: its status, then its reply's text if it completed. One query
 * for the status — none for an end already in hand — and one for the text.
 */
const readReading = async (task: TaskReading): Promise<Task> =>
  readWithStatus(task, await statusOf(task));

/**
 * The Task's status: one with an end recorded from `task`, with no query;
 * any other afresh, as `readTaskAfresh` reads it.
 */
export const taskStatus = async (task: TaskRow): Promise<TaskStatus> =>
  statusOf(task.state ? bareReading(task) : await readingOf(task));

/**
 * The Task as the client reads it. A completed Task's artifact is the text of
 * the reply recorded with its end; if the Owner has deleted it, it has none.
 * A Task with an end recorded is read from `task`; any other, afresh.
 */
export const readTask = async (task: TaskRow): Promise<Task> =>
  task.state ? readReading(bareReading(task)) : readTaskAfresh(task);

/**
 * `readTask`, from the Task's row as it is now. A caller following a Task
 * reads it this way, so an end recorded since it last fetched the row — a
 * cancel, which is recorded before its run has stopped, from any instance —
 * is seen on the next read.
 */
export const readTaskAfresh = async (task: TaskRow): Promise<Task> =>
  readReading(await readingOf(task));

/**
 * One of the Tasks `tokenId` started on `endpointId`, read, as `findTokenTask`
 * finds it and `readTask` reads it, in one query and one for its reply's text.
 */
export const readTokenTask = async (
  owner: { endpointId: string; tokenId: string },
  taskId: string,
): Promise<Task> => readReading(await findTokenTaskReading(owner, taskId));

// ------------------------------------------------------------------- Pushes

/**
 * Records the end `task` has reached, if it has and no one has recorded it,
 * then pushes it if its end is recorded. Never throws.
 */
const pushEnd = async (task: TaskRow): Promise<void> => {
  try {
    await taskStatus(task);
  } catch (error) {
    logger.error({ error, taskId: task.id }, "A2A push notification failed");
    return;
  }
  await pushRecordedEnd(task);
};

/**
 * A run in the Chat has ended, or a Task in it was canceled: push each of the
 * Chat's Tasks that has ended and still owes a push. Never throws.
 */
const pushOwedInChat = async (chatId: string): Promise<void> => {
  try {
    // One row per Task, however many configs it still owes.
    const tasks: TaskRow[] = await db
      .selectDistinct(getTableColumns(a2aTaskTable))
      .from(a2aTaskTable)
      .innerJoin(
        a2aPushConfigTable,
        eq(a2aPushConfigTable.taskId, a2aTaskTable.id),
      )
      .where(
        and(
          eq(a2aTaskTable.chatId, chatId),
          isNull(a2aPushConfigTable.notifiedAt),
        ),
      );
    await Promise.all(tasks.map(pushEnd));
  } catch (error) {
    logger.error({ error, chatId }, "A2A push notification failed");
  }
};

/**
 * A turn in the Chat has ended with `status` — its run's terminal write has
 * committed, or the run died: found as the next turn claims the Chat, or
 * marked failed by the recovery sweep. Records the end on the turn's Task, if
 * it has one and no end is recorded, which pushes it, then pushes any other
 * of the Chat's Tasks that still owes one. `turnId` names the turn; without
 * it, the Chat's current turn. Never throws. Only an A2A Chat has Tasks: a
 * caller that knows the Chat is not one skips this altogether.
 */
export const turnEnded = async ({
  chatId,
  turnId,
  status,
}: {
  chatId: string;
  turnId?: string | null;
  status: RunStatus;
}): Promise<void> => {
  try {
    const turn = turnId ?? (await currentTurnId(chatId));
    const state = END_OF_RUN[status];
    if (turn && state) await recordEnd(chatId, turn, state);
  } catch (error) {
    logger.error({ error, chatId }, "Recording an A2A Task's end failed");
  }
  await pushOwedInChat(chatId);
};

/** How many pending configs one sweep for missed pushes takes up. */
const MISSED_PUSH_SWEEP_LIMIT = 100;

/**
 * Pushes Tasks whose end no one pushed: the process died between its run's
 * end and the push, or the end was first noticed by a read. A Task with a
 * config not yet notified is swept up once it has an end recorded, or once
 * its Chat is no longer `running` — reading it then records its end, from
 * its own run or because the Chat has moved past it. Run by the scheduler,
 * under its lock; the pushes are not awaited, so a slow client URL can't
 * hold it. Never throws.
 */
export const sweepMissedEnds = async (): Promise<void> => {
  try {
    const rows = await db
      .select()
      .from(a2aTaskTable)
      .innerJoin(
        a2aPushConfigTable,
        eq(a2aPushConfigTable.taskId, a2aTaskTable.id),
      )
      .innerJoin(chatTable, eq(chatTable.id, a2aTaskTable.chatId))
      .where(
        and(
          isNull(a2aPushConfigTable.notifiedAt),
          or(isNotNull(a2aTaskTable.state), ne(chatTable.status, "running")),
        ),
      )
      .limit(MISSED_PUSH_SWEEP_LIMIT);
    const tasks = new Map(rows.map(({ a2a_task }) => [a2a_task.id, a2a_task]));
    for (const task of tasks.values()) void pushEnd(task);
  } catch (error) {
    logger.error({ error }, "Sweeping for missed A2A pushes failed");
  }
};

// ------------------------------------------------------------------- Cancel

/**
 * Records `task` canceled and stops its run, on whichever instance holds it.
 * `undefined`, stopping nothing, when the Task has already ended.
 */
export const cancelTask = async (
  task: TaskRow,
): Promise<TaskRow | undefined> => {
  const read = await readTask(task);
  if (TERMINAL_TASK_STATES.has(read.status!.state)) return undefined;

  const canceledAt = new Date();
  const claimed = await db.transaction(async (tx) => {
    // Claimed only while the Task's turn is still running: its Chat
    // `running`, on its turn, and no end recorded. The Chat's row is locked
    // first, so a run's terminal write, which records its Task's end in the
    // same transaction, lands wholly before the claim or wholly after it
    // (#1309): a run that ended first keeps its own end, and stops nothing.
    const [chat] = await tx
      .select({ status: chatTable.status })
      .from(chatTable)
      .where(eq(chatTable.id, task.chatId))
      .for("update");
    if (chat?.status !== "running") return undefined;
    if ((await currentTurnId(task.chatId, tx)) !== task.messageId) {
      return undefined;
    }
    const [row] = await tx
      .update(a2aTaskTable)
      .set({ state: "canceled", canceledAt, statusAt: canceledAt })
      .where(and(eq(a2aTaskTable.id, task.id), isNull(a2aTaskTable.state)))
      .returning();
    return row;
  });
  if (!claimed) return undefined;

  // A cancel that can't be sent is still recorded; the sweep stops the run.
  await cancelRun(task.chatId, { startedBefore: canceledAt }).catch(
    (error: unknown) =>
      logger.error({ error, taskId: task.id }, "Sending an A2A cancel failed"),
  );
  void pushOwedInChat(task.chatId);
  return claimed;
};
