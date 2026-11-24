import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  isNull,
  lt,
  lte,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { Role, TaskState, type Message, type Task } from "@a2a-js/sdk";
import { RequestMalformedError, TaskNotFoundError } from "@a2a-js/sdk/errors";
import { db, type Tx } from "../index.ts";
import {
  a2aTask as a2aTaskTable,
  chat as chatTable,
  chatMessage,
  type A2aTaskEndState,
} from "../db/schema.ts";
import type { RunStatus } from "../runs/types.ts";
import type { ChatMessageMetadata } from "../types.ts";
import type { ChatStatus } from "@platypus/schemas";
import { a2aTextPart, replyArtifact } from "./a2a-parts.ts";
import type { A2aCaller } from "./a2a-task.ts";

export type TaskRow = typeof a2aTaskTable.$inferSelect;

export const taskContextId = (
  task: Pick<TaskRow, "chatId" | "contextId">,
): string => task.contextId ?? task.chatId;

export const isTaskContext = (contextId: string): SQL | undefined =>
  or(
    eq(a2aTaskTable.contextId, contextId),
    and(isNull(a2aTaskTable.contextId), eq(a2aTaskTable.chatId, contextId)),
  );

export type Executor = typeof db | Tx;

export const END_OF_RUN: Partial<Record<RunStatus, A2aTaskEndState>> = {
  succeeded: "completed",
  failed: "failed",
  cancelled: "canceled",
};

const STATE_OF_END: Record<A2aTaskEndState, TaskState> = {
  completed: TaskState.TASK_STATE_COMPLETED,
  failed: TaskState.TASK_STATE_FAILED,
  canceled: TaskState.TASK_STATE_CANCELED,
};

export const endStateOf = (state: TaskState): A2aTaskEndState | undefined =>
  (Object.keys(STATE_OF_END) as A2aTaskEndState[]).find(
    (end) => STATE_OF_END[end] === state,
  );

export const firstReply = async (
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

export const isA2aChat = (
  chat: { a2aEndpointId?: string | null } | undefined,
): boolean => !!chat?.a2aEndpointId;

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

export const findA2aTask = (
  caller: A2aCaller,
  taskId: string,
): Promise<TaskRow> =>
  findTokenTask(
    { endpointId: caller.endpoint.id, tokenId: caller.token.id },
    taskId,
  );

export type TaskStatus = {
  state: TaskState;
  statusAt: Date;
  replyId: string | null;
};

export type TaskReading = TaskRow & {
  chatStatus: ChatStatus | null;
  leafId: string | null;
  firstReplyId: string | null;
};

export type TaskRowCursor = { at: Date; id: string };

// why: the same first-reply rule as firstReply; change them together
const taskReadingQuery = (where: SQL | undefined) => {
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

export const readTaskRows = async (
  where: SQL | undefined,
  { limit }: { limit?: number } = {},
): Promise<TaskReading[]> => {
  const query = taskReadingQuery(where);
  return limit === undefined ? query : query.limit(limit);
};

// why: newest status first, the order ListTasks pages in
export const readTaskPage = async (
  where: SQL | undefined,
  { after, limit }: { after?: TaskRowCursor; limit: number },
): Promise<TaskReading[]> =>
  taskReadingQuery(
    and(
      where,
      after
        ? or(
            lt(a2aTaskTable.statusAt, after.at),
            and(
              lte(a2aTaskTable.statusAt, after.at),
              lt(a2aTaskTable.id, after.id),
            ),
          )
        : undefined,
    ),
  )
    .orderBy(desc(a2aTaskTable.statusAt), desc(a2aTaskTable.id))
    .limit(limit);

export const recordedStatus = (task: TaskRow & { state: A2aTaskEndState }) => ({
  state: STATE_OF_END[task.state],
  statusAt: task.statusAt,
  replyId: task.replyId,
});

export type DerivedStatus =
  { status: TaskStatus } | { unrecordedEnd: A2aTaskEndState };

export const deriveStatus = (task: TaskReading): DerivedStatus => {
  if (task.state) {
    return { status: recordedStatus({ ...task, state: task.state }) };
  }
  const replyId = task.firstReplyId ?? undefined;
  const isThisTurn =
    task.leafId === task.messageId ||
    (replyId !== undefined && task.leafId === replyId);
  if (!isThisTurn) return { unrecordedEnd: replyId ? "completed" : "failed" };
  if (task.chatStatus === "running") {
    return {
      status: {
        state: replyId
          ? TaskState.TASK_STATE_WORKING
          : TaskState.TASK_STATE_SUBMITTED,
        statusAt: task.statusAt,
        replyId: null,
      },
    };
  }
  return {
    unrecordedEnd:
      (task.chatStatus ? END_OF_RUN[task.chatStatus] : undefined) ?? "failed",
  };
};

// why: a reader that only lists Tasks reports a derived end without recording it
export const derivedTaskStatus = (task: TaskReading): TaskStatus => {
  const derived = deriveStatus(task);
  if ("status" in derived) return derived.status;
  return {
    state: STATE_OF_END[derived.unrecordedEnd],
    statusAt: task.statusAt,
    replyId: task.firstReplyId,
  };
};

type ReplyParts = { type: string; text?: string }[];

export type StopReason = "max_steps" | "output_limit";

export type RecordedReply = { text: string; stopReason?: StopReason };

const stopReasonOf = (metadata: unknown): StopReason | undefined => {
  const marked = (metadata ?? {}) as Pick<
    ChatMessageMetadata,
    "stoppedAtStepLimit" | "truncatedByTokenLimit"
  >;
  if (marked.stoppedAtStepLimit) return "max_steps";
  if (marked.truncatedByTokenLimit) return "output_limit";
  return undefined;
};

const STOP_REASON_TEXT: Record<StopReason, string> = {
  max_steps: "Reply cut short at the step limit, so it may be incomplete.",
  output_limit:
    "Reply cut short at the model's output limit, so it may be incomplete.",
};

export const recordedReplies = async (
  tasks: { id: string; chatId: string; status: TaskStatus }[],
  { withText }: { withText: boolean },
): Promise<Map<string, RecordedReply>> => {
  const completed = tasks.flatMap(({ id, chatId, status }) =>
    status.state === TaskState.TASK_STATE_COMPLETED && status.replyId
      ? [{ id, chatId, replyId: status.replyId }]
      : [],
  );
  if (!completed.length) return new Map();
  const columns = {
    chatId: chatMessage.chatId,
    id: chatMessage.id,
    metadata: chatMessage.metadata,
  };
  const replies: {
    chatId: string;
    id: string;
    metadata: unknown;
    parts?: unknown;
  }[] = await db
    .select(withText ? { ...columns, parts: chatMessage.parts } : columns)
    .from(chatMessage)
    .where(
      and(
        or(
          ...completed.map((task) =>
            and(
              eq(chatMessage.chatId, task.chatId),
              eq(chatMessage.id, task.replyId),
            ),
          ),
        ),
        isNull(chatMessage.deletedAt),
      ),
    );
  const read = new Map<string, RecordedReply>();
  for (const task of completed) {
    const reply = replies.find(
      (row) => row.chatId === task.chatId && row.id === task.replyId,
    );
    if (!reply) continue;
    read.set(task.id, {
      text: ((reply.parts ?? []) as ReplyParts)
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n\n"),
      stopReason: stopReasonOf(reply.metadata),
    });
  }
  return read;
};

const stopMessage = (
  task: Pick<Task, "id" | "contextId">,
  replyId: string,
  stopReason: StopReason,
): Message => ({
  messageId: `${replyId}:${stopReason}`,
  contextId: task.contextId,
  taskId: task.id,
  role: Role.ROLE_AGENT,
  parts: [a2aTextPart(STOP_REASON_TEXT[stopReason])],
  metadata: undefined,
  extensions: [],
  referenceTaskIds: [],
});

export const toTask = (
  task: TaskRow,
  { state, statusAt, replyId }: TaskStatus,
  reply: RecordedReply | undefined,
): Task => {
  const id = task.id;
  const contextId = taskContextId(task);
  const stopReason = replyId ? reply?.stopReason : undefined;
  const message =
    replyId && stopReason
      ? stopMessage({ id, contextId }, replyId, stopReason)
      : undefined;
  const result: Task = {
    id,
    contextId,
    status: {
      state,
      message,
      timestamp: statusAt.toISOString(),
    },
    artifacts:
      reply?.text && replyId ? [replyArtifact(replyId, reply.text)] : [],
    history: [],
    metadata: stopReason ? { stopReason } : undefined,
  };
  chatIds.set(result, task.chatId);
  return result;
};

const chatIds = new WeakMap<Task, string>();

export const chatIdOf = (task: Task): string | undefined => chatIds.get(task);

export const readWithStatus = async (
  task: TaskRow,
  status: TaskStatus,
): Promise<Task> => {
  const replies = await recordedReplies([{ ...task, status }], {
    withText: true,
  });
  return toTask(task, status, replies.get(task.id));
};

export const readingOf = async (task: TaskRow): Promise<TaskReading> => {
  const [reading] = await readTaskRows(eq(a2aTaskTable.id, task.id));
  return reading ?? bareReading(task);
};

export const bareReading = (task: TaskRow): TaskReading => ({
  ...task,
  chatStatus: null,
  leafId: null,
  firstReplyId: null,
});

export const readRecordedTask = (
  task: TaskRow & { state: A2aTaskEndState },
): Promise<Task> => readWithStatus(task, recordedStatus(task));

export const taskHasEnded = async (task: TaskRow): Promise<boolean> => {
  if (task.state) return true;
  const derived = deriveStatus(await readingOf(task));
  return (
    "unrecordedEnd" in derived || TERMINAL_TASK_STATES.has(derived.status.state)
  );
};

export const findTokenTaskReading = async (
  owner: { endpointId: string; tokenId: string },
  taskId: string,
): Promise<TaskReading> => {
  if (!taskId) throw new RequestMalformedError("A Task id is required");
  const [task] = await readTaskRows(
    and(
      eq(a2aTaskTable.id, taskId),
      eq(a2aTaskTable.endpointId, owner.endpointId),
      eq(a2aTaskTable.tokenId, owner.tokenId),
    ),
  );
  if (!task) throw new TaskNotFoundError();
  return task;
};

export const TERMINAL_TASK_STATES = new Set([
  TaskState.TASK_STATE_COMPLETED,
  TaskState.TASK_STATE_FAILED,
  TaskState.TASK_STATE_CANCELED,
]);

export const requireStatus = (task: Task): NonNullable<Task["status"]> => {
  if (!task.status) throw new Error(`Task '${task.id}' has no status`);
  return task.status;
};

export const isTerminal = (task: Task): boolean =>
  TERMINAL_TASK_STATES.has(requireStatus(task).state);
