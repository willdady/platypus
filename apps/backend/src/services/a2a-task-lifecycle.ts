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
import { db, type Tx } from "../index.ts";
import {
  a2aPushConfig as a2aPushConfigTable,
  a2aTask as a2aTaskTable,
  chat as chatTable,
  type A2aTaskEndState,
} from "../db/schema.ts";
import { logger } from "../logger.ts";
import { cancelRun } from "../runs/run-cancel.ts";
import type { RunStatus } from "../runs/types.ts";
import {
  bareReading,
  currentTurnId,
  deriveStatus,
  END_OF_RUN,
  findTokenTaskReading,
  firstReply,
  readingOf,
  readTaskRows,
  readWithStatus,
  recordedStatus,
  isTerminal,
  type Executor,
  type TaskReading,
  type TaskRow,
  type TaskStatus,
} from "./a2a-task-state.ts";
import { pushRecordedEnd } from "./a2a-push.ts";

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

const recordEnd = async (
  chatId: string,
  messageId: string,
  state: A2aTaskEndState,
): Promise<TaskRow | undefined> => {
  const recorded = await writeEnd(db, chatId, messageId, state);
  if (recorded) void pushRecordedEnd(recorded);
  return recorded;
};

export const endTurnIn = async (
  tx: Tx,
  chatId: string,
  turnId: string,
  status: RunStatus,
): Promise<TaskRow | undefined> => {
  const state = END_OF_RUN[status];
  return state ? writeEnd(tx, chatId, turnId, state) : undefined;
};

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

export const statusOf = async (task: TaskReading): Promise<TaskStatus> => {
  const derived = deriveStatus(task);
  return "unrecordedEnd" in derived
    ? settle(task, derived.unrecordedEnd)
    : derived.status;
};

const readReading = async (task: TaskReading): Promise<Task> =>
  readWithStatus(task, await statusOf(task));

export const taskStatus = async (task: TaskRow): Promise<TaskStatus> =>
  statusOf(task.state ? bareReading(task) : await readingOf(task));

export const readTask = async (task: TaskRow): Promise<Task> =>
  task.state ? readReading(bareReading(task)) : readTaskAfresh(task);

export const readTaskAfresh = async (task: TaskRow): Promise<Task> =>
  readReading(await readingOf(task));

export const readTokenTask = async (
  owner: { endpointId: string; tokenId: string },
  taskId: string,
): Promise<Task> => readReading(await findTokenTaskReading(owner, taskId));

const pushEnd = async (task: TaskRow): Promise<void> => {
  try {
    await taskStatus(task);
  } catch (error) {
    logger.error({ error, taskId: task.id }, "A2A push notification failed");
    return;
  }
  await pushRecordedEnd(task);
};

const pushOwedInChat = async (chatId: string): Promise<void> => {
  try {
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

const MISSED_SWEEP_LIMIT = 100;

// why: a Task whose Chat row is gone has stopped too, and derives the end a null Chat status gives
const chatStopped = () =>
  or(isNull(chatTable.status), ne(chatTable.status, "running"));

// why: a crash can lose a run's end; record it here once its Chat stops, so no reader derives it
const recordMissedEnds = async (): Promise<void> => {
  const tasks = await readTaskRows(
    and(isNull(a2aTaskTable.state), chatStopped()),
    { limit: MISSED_SWEEP_LIMIT },
  );
  for (const task of tasks) await statusOf(task);
};

const pushMissedEnds = async (): Promise<void> => {
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
        or(isNotNull(a2aTaskTable.state), chatStopped()),
      ),
    )
    .limit(MISSED_SWEEP_LIMIT);
  const tasks = new Map(rows.map(({ a2a_task }) => [a2a_task.id, a2a_task]));
  for (const task of tasks.values()) void pushEnd(task);
};

export const sweepMissedEnds = async (): Promise<void> => {
  try {
    await recordMissedEnds();
  } catch (error) {
    logger.error({ error }, "Recording missed A2A Task ends failed");
  }
  try {
    await pushMissedEnds();
  } catch (error) {
    logger.error({ error }, "Sweeping for missed A2A pushes failed");
  }
};

export const cancelTask = async (
  task: TaskRow,
): Promise<TaskRow | undefined> => {
  const read = await readTask(task);
  if (isTerminal(read)) return undefined;

  const canceledAt = new Date();
  const claimed = await db.transaction(async (tx) => {
    // why: Chat row locked first, so a run's terminal write lands wholly before or after the claim
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

  // why: the cancel is recorded; a run this message misses is stopped by the sweep
  await cancelRun(task.chatId, { startedBefore: canceledAt }).catch(
    (error: unknown) =>
      logger.error({ error, taskId: task.id }, "Sending an A2A cancel failed"),
  );
  void pushOwedInChat(task.chatId);
  return claimed;
};
