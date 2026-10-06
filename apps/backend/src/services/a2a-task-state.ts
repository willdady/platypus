import { and, asc, eq, isNull } from "drizzle-orm";
import { TaskState, type Part, type Task } from "@a2a-js/sdk";
import { TaskNotFoundError } from "@a2a-js/sdk/errors";
import { db } from "../index.ts";
import {
  a2aTask as a2aTaskTable,
  chat as chatTable,
  chatMessage,
  type A2aTaskEndState,
} from "../db/schema.ts";
import type { RunStatus } from "../runs/types.ts";
import type { ChatClaimTx } from "../runs/sinks/chat-sink.ts";
import { pushTaskIfEnded } from "./a2a-push.ts";

/**
 * An A2A Task as a client reads it (ADR-0032). While its run is going, its
 * state is read from its Chat's run every time, so any backend instance
 * answers alike. When the run ends, how it ended is recorded on the Task,
 * with the reply it wrote: the Chat can move on to another turn, and its
 * Owner can regenerate or delete that reply, and the Task keeps what it was.
 */

export type TaskRow = typeof a2aTaskTable.$inferSelect;

/** Where a Task's rows are read and written: the database, or a transaction. */
type Executor = typeof db | ChatClaimTx;

/** A text part of an outbound A2A message or artifact. */
const a2aTextPart = (text: string): Part => ({
  content: { $case: "text", value: text },
  metadata: undefined,
  filename: "",
  mediaType: "text/plain",
});

/** A finished run's Chat status as the end a Task records. */
const END_OF_RUN: Partial<Record<RunStatus, A2aTaskEndState>> = {
  succeeded: "completed",
  failed: "failed",
  cancelled: "canceled",
};

/** A recorded end as a Task state. */
const STATE_OF_END: Record<A2aTaskEndState, TaskState> = {
  completed: TaskState.TASK_STATE_COMPLETED,
  failed: TaskState.TASK_STATE_FAILED,
  canceled: TaskState.TASK_STATE_CANCELED,
};

/** The recorded end a Task state is, if it is one. */
export const endStateOf = (state: TaskState): A2aTaskEndState | undefined =>
  (Object.keys(STATE_OF_END) as A2aTaskEndState[]).find(
    (end) => STATE_OF_END[end] === state,
  );

/**
 * The reply the turn answering `messageId` wrote: the first assistant message
 * under it still in the Chat. A later one is a regenerate the Owner ran in
 * the UI.
 */
const firstReply = async (
  chatId: string,
  messageId: string,
  executor: Executor = db,
): Promise<string | undefined> => {
  const [reply] = await executor
    .select({ id: chatMessage.id })
    .from(chatMessage)
    .where(
      and(
        eq(chatMessage.chatId, chatId),
        eq(chatMessage.parentId, messageId),
        eq(chatMessage.role, "assistant"),
        isNull(chatMessage.deletedAt),
      ),
    )
    .orderBy(asc(chatMessage.createdAt))
    .limit(1);
  return reply?.id;
};

/**
 * Records `state` as how the turn answering `messageId` ended, on its Task if
 * it has one, with the reply it wrote and the time. The first end recorded
 * stands, and with it its reply: a later regenerate or delete of that reply
 * changes nothing the Task reads. Answers with the Task as recorded, if it
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
  if (recorded) void pushTaskIfEnded(recorded);
  return recorded;
};

/**
 * Records how the turn answering `messageId` ended with `status`, as
 * `recordEnd` does. A status that is no end records nothing.
 */
export const recordTaskEnd = async (
  chatId: string,
  messageId: string,
  status: RunStatus,
): Promise<TaskRow | undefined> => {
  const state = END_OF_RUN[status];
  return state ? recordEnd(chatId, messageId, state) : undefined;
};

/**
 * Records how the turn answering `messageId` ended with `status`, in `tx`:
 * the transaction its Chat's terminal status is written in, so no claim of
 * the next turn reads the Chat ended and the Task not (#1309). Pushes
 * nothing; its caller pushes once `tx` has committed.
 */
export const recordTaskEndIn = async (
  tx: ChatClaimTx,
  chatId: string,
  messageId: string,
  status: RunStatus,
): Promise<TaskRow | undefined> => {
  const state = END_OF_RUN[status];
  return state ? writeEnd(tx, chatId, messageId, state) : undefined;
};

/**
 * The user message the Chat's current turn answers: its active leaf, or the
 * leaf's parent when the leaf is the reply.
 */
export const currentTurnId = async (
  chatId: string,
  executor: Executor = db,
): Promise<string | undefined> => {
  const [chat] = await executor
    .select({ leafId: chatTable.activeLeafId })
    .from(chatTable)
    .where(eq(chatTable.id, chatId))
    .limit(1);
  if (!chat?.leafId) return undefined;
  const [leaf] = await executor
    .select({ role: chatMessage.role, parentId: chatMessage.parentId })
    .from(chatMessage)
    .where(and(eq(chatMessage.chatId, chatId), eq(chatMessage.id, chat.leafId)))
    .limit(1);
  if (!leaf) return undefined;
  return leaf.role === "assistant" ? (leaf.parentId ?? undefined) : chat.leafId;
};

/**
 * One of the Tasks `tokenId` started on `endpointId` (ADR-0032). A token
 * reaches only its own: another token's Task, on this endpoint or another,
 * answers as an unknown id does, so the caller learns nothing. A deleted
 * token's Tasks are reached by no one.
 */
export const findTokenTask = async (
  owner: { endpointId: string; tokenId: string },
  taskId: string,
): Promise<TaskRow> => {
  const [task] = await db
    .select()
    .from(a2aTaskTable)
    .where(
      and(
        eq(a2aTaskTable.id, taskId),
        eq(a2aTaskTable.endpointId, owner.endpointId),
        eq(a2aTaskTable.tokenId, owner.tokenId),
      ),
    )
    .limit(1);
  if (!task) throw new TaskNotFoundError();
  return task;
};

/** A Task's state, status timestamp and recorded reply, as `readTask` reads them. */
type TaskStatus = { state: TaskState; statusAt: Date; replyId: string | null };

/** A Task with an end recorded, as its status. */
const recordedStatus = (task: TaskRow & { state: A2aTaskEndState }) => ({
  state: STATE_OF_END[task.state],
  statusAt: task.statusAt,
  replyId: task.replyId,
});

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
 * The Task's state. Once its run has ended, the end recorded on it. Before
 * that it comes from the Chat's run: `submitted` until the reply's first
 * write and `working` after. An end read from the Chat that is not yet
 * recorded — a Task made just as its run ended, or one whose run's end was
 * lost — is recorded here, so it stands once the Chat moves on.
 */
const taskState = async (task: TaskRow): Promise<TaskStatus> => {
  if (task.state) return recordedStatus({ ...task, state: task.state });
  const replyId = await firstReply(task.chatId, task.messageId);
  const [chat] = await db
    .select({ status: chatTable.status, leafId: chatTable.activeLeafId })
    .from(chatTable)
    .where(eq(chatTable.id, task.chatId))
    .limit(1);
  const isThisTurn =
    chat?.leafId === task.messageId ||
    (replyId !== undefined && chat?.leafId === replyId);
  // Moved past with no end recorded, which the end of its run and its first
  // read both missed. Its reply, if any, is the best evidence of how it ended.
  if (!isThisTurn) return settle(task, replyId ? "completed" : "failed");
  if (chat.status === "running") {
    return {
      state: replyId
        ? TaskState.TASK_STATE_WORKING
        : TaskState.TASK_STATE_SUBMITTED,
      statusAt: task.statusAt,
      replyId: null,
    };
  }
  return settle(task, END_OF_RUN[chat.status as RunStatus] ?? "failed");
};

/** The text of a reply still in the Chat, if it is. */
const replyText = async (
  chatId: string,
  replyId: string,
): Promise<string | undefined> => {
  const [reply] = await db
    .select({ parts: chatMessage.parts })
    .from(chatMessage)
    .where(
      and(
        eq(chatMessage.chatId, chatId),
        eq(chatMessage.id, replyId),
        isNull(chatMessage.deletedAt),
      ),
    )
    .limit(1);
  return reply
    ? (reply.parts as { type: string; text?: string }[])
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n\n")
    : undefined;
};

/**
 * The Task as the client reads it. A completed Task's artifact is the text of
 * the reply recorded with its end; if the Owner has deleted it, it has none.
 */
export const readTask = async (task: TaskRow): Promise<Task> => {
  const { state, statusAt, replyId } = await taskState(task);
  const text =
    state === TaskState.TASK_STATE_COMPLETED && replyId
      ? await replyText(task.chatId, replyId)
      : undefined;

  return {
    id: task.id,
    contextId: task.chatId,
    status: {
      state,
      message: undefined,
      timestamp: statusAt.toISOString(),
    },
    artifacts:
      text && replyId
        ? [
            {
              artifactId: replyId,
              name: "reply",
              description: "",
              parts: [a2aTextPart(text)],
              metadata: undefined,
              extensions: [],
            },
          ]
        : [],
    history: [],
    metadata: undefined,
  };
};

/**
 * `readTask`, from the Task's row as it is now. A caller following a Task
 * reads it this way, so an end recorded since it last fetched the row — a
 * cancel, which is recorded before its run has stopped, from any instance —
 * is seen on the next read.
 */
export const readTaskAfresh = async (task: TaskRow): Promise<Task> => {
  const [row] = await db
    .select()
    .from(a2aTaskTable)
    .where(eq(a2aTaskTable.id, task.id))
    .limit(1);
  return readTask(row ?? task);
};

export const TERMINAL_TASK_STATES = new Set([
  TaskState.TASK_STATE_COMPLETED,
  TaskState.TASK_STATE_FAILED,
  TaskState.TASK_STATE_CANCELED,
]);
