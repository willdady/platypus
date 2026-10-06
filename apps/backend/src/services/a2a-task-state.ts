import {
  and,
  asc,
  eq,
  getTableColumns,
  isNull,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { TaskState, type Task } from "@a2a-js/sdk";
import { RequestMalformedError, TaskNotFoundError } from "@a2a-js/sdk/errors";
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
import { replyArtifact } from "./a2a-parts.ts";

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
 * Whether a Chat is an A2A client's, and so may hold A2A Tasks: it names the
 * endpoint that started it, or, from before the endpoint was stored on it,
 * the client's label. `chat` is the Chat as read, or the columns a new one
 * starts with.
 */
export const isA2aChat = (
  chat:
    | {
        a2aEndpointId?: string | null;
        a2aClientName?: string | null;
      }
    | undefined,
): boolean => !!(chat?.a2aEndpointId || chat?.a2aClientName);

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
 * token's Tasks are reached by no one. A missing id is invalid params, not
 * an unknown Task.
 */
export const findTokenTask = async (
  owner: { endpointId: string; tokenId: string },
  taskId: string,
): Promise<TaskRow> => {
  if (!taskId) throw new RequestMalformedError("A Task id is required");
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
export type TaskStatus = {
  state: TaskState;
  statusAt: Date;
  replyId: string | null;
};

/**
 * A Task's row with what its state is read from while its run is going: its
 * Chat's status and active leaf, and the first reply of its turn. Null where
 * the Chat is gone; the reply is read only for a Task with no end recorded.
 */
export type TaskReading = TaskRow & {
  chatStatus: string | null;
  leafId: string | null;
  firstReplyId: string | null;
};

/**
 * Tasks matching `where`, each read with its Chat and its turn's first reply
 * in the one query (see `firstReply`, which this reads the same way).
 */
export const readTaskRows = async (
  where: SQL | undefined,
): Promise<TaskReading[]> => {
  const reply = db
    .select({ id: chatMessage.id })
    .from(chatMessage)
    .where(
      and(
        isNull(a2aTaskTable.state),
        eq(chatMessage.chatId, a2aTaskTable.chatId),
        eq(chatMessage.parentId, a2aTaskTable.messageId),
        eq(chatMessage.role, "assistant"),
        isNull(chatMessage.deletedAt),
      ),
    )
    .orderBy(asc(chatMessage.createdAt))
    .limit(1)
    .as("first_reply");
  return db
    .select({
      ...getTableColumns(a2aTaskTable),
      chatStatus: chatTable.status,
      leafId: chatTable.activeLeafId,
      firstReplyId: reply.id,
    })
    .from(a2aTaskTable)
    .leftJoin(chatTable, eq(chatTable.id, a2aTaskTable.chatId))
    .leftJoinLateral(reply, sql`true`)
    .where(where);
};

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
export const statusOf = async (task: TaskReading): Promise<TaskStatus> => {
  if (task.state) return recordedStatus({ ...task, state: task.state });
  const replyId = task.firstReplyId ?? undefined;
  const isThisTurn =
    task.leafId === task.messageId ||
    (replyId !== undefined && task.leafId === replyId);
  // Moved past with no end recorded, which the end of its run and its first
  // read both missed. Its reply, if any, is the best evidence of how it ended.
  if (!isThisTurn) return settle(task, replyId ? "completed" : "failed");
  if (task.chatStatus === "running") {
    return {
      state: replyId
        ? TaskState.TASK_STATE_WORKING
        : TaskState.TASK_STATE_SUBMITTED,
      statusAt: task.statusAt,
      replyId: null,
    };
  }
  return settle(task, END_OF_RUN[task.chatStatus as RunStatus] ?? "failed");
};

/** A reply's parts, as stored. */
type ReplyParts = { type: string; text?: string }[];

/**
 * The text of each completed Task's recorded reply still in its Chat, keyed
 * by Task id, in one query. A Task whose reply the Owner deleted has none.
 */
export const replyTexts = async (
  tasks: { id: string; chatId: string; status: TaskStatus }[],
): Promise<Map<string, string>> => {
  const completed = tasks.filter(
    (task) =>
      task.status.state === TaskState.TASK_STATE_COMPLETED &&
      task.status.replyId,
  );
  if (!completed.length) return new Map();
  const replies = await db
    .select({
      chatId: chatMessage.chatId,
      id: chatMessage.id,
      parts: chatMessage.parts,
    })
    .from(chatMessage)
    .where(
      and(
        or(
          ...completed.map((task) =>
            and(
              eq(chatMessage.chatId, task.chatId),
              eq(chatMessage.id, task.status.replyId!),
            ),
          ),
        ),
        isNull(chatMessage.deletedAt),
      ),
    );
  const texts = new Map<string, string>();
  for (const task of completed) {
    const reply = replies.find(
      (row) => row.chatId === task.chatId && row.id === task.status.replyId,
    );
    if (!reply) continue;
    texts.set(
      task.id,
      (reply.parts as ReplyParts)
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n\n"),
    );
  }
  return texts;
};

/**
 * The Task as the client reads it, from its status and, if completed, its
 * reply's text: its artifact. A completed Task whose reply the Owner has
 * deleted has none.
 */
export const toTask = (
  task: TaskRow,
  { state, statusAt, replyId }: TaskStatus,
  text: string | undefined,
): Task => ({
  id: task.id,
  contextId: task.chatId,
  status: {
    state,
    message: undefined,
    timestamp: statusAt.toISOString(),
  },
  artifacts: text && replyId ? [replyArtifact(replyId, text)] : [],
  history: [],
  metadata: undefined,
});

/**
 * A Task, read: its status, then its reply's text if it completed. One query
 * for the status — none for an end already in hand — and one for the text.
 */
const readReading = async (task: TaskReading): Promise<Task> => {
  const status = await statusOf(task);
  const texts = await replyTexts([{ ...task, status }]);
  return toTask(task, status, texts.get(task.id));
};

/**
 * `readTaskAfresh`'s reading of the Task's row as it is now. A Task gone
 * since, deleted with its Chat, is read from `task` with no Chat.
 */
const readingOf = async (task: TaskRow): Promise<TaskReading> => {
  const [reading] = await readTaskRows(eq(a2aTaskTable.id, task.id));
  return reading ?? bareReading(task);
};

/**
 * A Task's row as a reading with nothing read beside it: all a Task with an
 * end recorded needs, and all one whose Chat is gone has.
 */
const bareReading = (task: TaskRow): TaskReading => ({
  ...task,
  chatStatus: null,
  leafId: null,
  firstReplyId: null,
});

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
): Promise<Task> => {
  if (!taskId) throw new RequestMalformedError("A Task id is required");
  const [task] = await readTaskRows(
    and(
      eq(a2aTaskTable.id, taskId),
      eq(a2aTaskTable.endpointId, owner.endpointId),
      eq(a2aTaskTable.tokenId, owner.tokenId),
    ),
  );
  if (!task) throw new TaskNotFoundError();
  return readReading(task);
};

export const TERMINAL_TASK_STATES = new Set([
  TaskState.TASK_STATE_COMPLETED,
  TaskState.TASK_STATE_FAILED,
  TaskState.TASK_STATE_CANCELED,
]);
