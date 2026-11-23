import { randomUUID } from "node:crypto";
import { v5 as uuidv5 } from "uuid";
import { and, count, eq, gte, inArray, isNull, or } from "drizzle-orm";
import {
  Role,
  TaskState,
  type GetTaskRequest,
  type ListTasksRequest,
  type ListTasksResponse,
  type Message,
  type Part,
  type SendMessageRequest,
  type Task,
} from "@a2a-js/sdk";
import {
  ContentTypeNotSupportedError,
  RequestMalformedError,
  TaskNotFoundError,
  UnsupportedOperationError,
} from "@a2a-js/sdk/errors";
import { db } from "../index.ts";
import {
  a2aTask as a2aTaskTable,
  chat as chatTable,
  chatMessage,
} from "../db/schema.ts";
import {
  ConflictError,
  isUniqueViolation,
  ValidationError,
} from "../errors.ts";
import { CHAT_BUSY_MESSAGE } from "../runs/sinks/chat-sink.ts";
import { workspaceScopeForA2a } from "../scope.ts";
import { startChatTurn } from "./chat-turn.ts";
import { callerDataBlock } from "./caller-data.ts";
import type { LiveA2aEndpoint } from "./a2a-endpoint.ts";
import {
  currentTurnId,
  derivedTaskStatus,
  findA2aTask,
  readTaskPage,
  readTaskRows,
  recordedReplies,
  taskContextId,
  isTaskContext,
  toTask,
  endStateOf,
  isTerminal,
  type Executor,
  type TaskRow,
  type TaskRowCursor,
} from "./a2a-task-state.ts";
import {
  readTask,
  readTaskAfresh,
  readTokenTask,
  taskStatus,
} from "./a2a-task-lifecycle.ts";
import {
  a2aFallbackPollMs,
  a2aTaskEvents,
  produceA2aTaskEvents,
  type A2aTaskSubscription,
} from "./a2a-events.ts";
import { checkPushConfig, storePushConfig } from "./a2a-push.ts";
import {
  A2aAtCapacityError,
  acquireA2aFollowerSlot,
  acquireA2aRunSlot,
} from "./a2a-call.ts";
import { callerIsLive } from "./a2a-liveness.ts";
import { chatRunIsLive } from "../runs/chat-run-heartbeat.ts";
import { oneRow } from "../db/one-row.ts";

export type A2aCaller = {
  endpoint: LiveA2aEndpoint;
  token: { id: string; name: string; tokenCreatedAt: Date };
  origin: string;
  signal?: AbortSignal;
};

// why: fixed for good; a new namespace re-keys every A2A Chat and breaks retries
const A2A_CHAT_NAMESPACE = "0b6f4d2e-6a43-4d8e-9c1a-3f0e2b7d5a91";

export const a2aChatId = (tokenId: string, messageId: string): string =>
  uuidv5(JSON.stringify([tokenId, messageId]), A2A_CHAT_NAMESPACE);

export const a2aContextChatId = (tokenId: string, contextId: string): string =>
  uuidv5(JSON.stringify([tokenId, "context", contextId]), A2A_CHAT_NAMESPACE);

export const MAX_CONTEXT_ID_LENGTH = 128;

const A2A_BLOCKING_WAIT_MS = 30_000;

const fromA2aPart = (part: Part) => {
  switch (part.content?.$case) {
    case "text":
      return { type: "text" as const, text: part.content.value };
    case "data":
      return {
        type: "text" as const,
        text: callerDataBlock("A2A message data", [
          JSON.stringify(part.content.value, null, 2),
        ]),
      };
    default:
      throw new ContentTypeNotSupportedError(
        "Only text and data parts are supported",
      );
  }
};

export const withNullDataParts = (
  params: SendMessageRequest,
  nullDataParts: ReadonlySet<number>,
): SendMessageRequest => {
  const { message } = params;
  if (!message || nullDataParts.size === 0) return params;
  const parts = message.parts.map((part, index) =>
    !part.content && nullDataParts.has(index)
      ? { ...part, content: { $case: "data" as const, value: null } }
      : part,
  );
  return { ...params, message: { ...message, parts } };
};

const findTask = async (where: ReturnType<typeof and>) => {
  const [row] = await db.select().from(a2aTaskTable).where(where).limit(1);
  return row;
};

type TurnContext = { chatId: string; contextId: string | null };

const insertTask = async (
  executor: Executor,
  caller: A2aCaller,
  { chatId, contextId }: TurnContext,
  messageId: string,
): Promise<TaskRow> => {
  const now = new Date();
  const row = oneRow(
    await executor
      .insert(a2aTaskTable)
      .values({
        id: randomUUID(),
        chatId,
        contextId,
        messageId,
        endpointId: caller.endpoint.id,
        tokenId: caller.token.id,
        statusAt: now,
        createdAt: now,
      })
      .returning(),
  );
  return row;
};

const taskFor = async (
  caller: A2aCaller,
  context: TurnContext,
  messageId: string,
): Promise<TaskRow> => {
  const where = and(
    eq(a2aTaskTable.chatId, context.chatId),
    eq(a2aTaskTable.messageId, messageId),
  );
  const existing = await findTask(where);
  if (existing) return existing;
  try {
    return await insertTask(db, caller, context, messageId);
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const raced = await findTask(where);
    if (!raced) throw error;
    return raced;
  }
};

export class A2aChatBusyError extends UnsupportedOperationError {
  readonly taskId?: string;

  constructor(taskId?: string) {
    super({
      message: CHAT_BUSY_MESSAGE,
      metadata: taskId ? { taskId } : undefined,
    });
    this.name = "UnsupportedOperationError";
    this.taskId = taskId;
  }
}

const busyError = async (caller: A2aCaller, chatId: string) => {
  const turnId = await currentTurnId(chatId);
  const task = turnId
    ? await findTask(
        and(
          eq(a2aTaskTable.chatId, chatId),
          eq(a2aTaskTable.messageId, turnId),
          eq(a2aTaskTable.tokenId, caller.token.id),
        ),
      )
    : undefined;
  if (task) await readTask(task);
  return new A2aChatBusyError(task?.id);
};

export const takeFollowerSlot = (caller: A2aCaller): (() => void) => {
  const release = acquireA2aFollowerSlot(caller.token.id);
  if (!release) {
    throw new A2aAtCapacityError("Too many callers are following A2A Tasks");
  }
  return release;
};

const waitForTask = async (
  caller: A2aCaller,
  task: TaskRow,
  deadline: number,
  events: A2aTaskSubscription,
): Promise<Task> => {
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0 || caller.signal?.aborted) break;
    const event = await events.next(
      events.produced ? left : Math.min(left, a2aFallbackPollMs()),
      caller.signal,
    );
    if (event?.kind === "delta" || event?.kind === "status") continue;
    if (event?.kind !== "end") {
      if (Date.now() >= deadline || caller.signal?.aborted) break;
    }
    if (!(await callerIsLive(caller))) throw new TaskNotFoundError();
    const read =
      event?.kind === "end" && event.task
        ? event.task
        : await readTaskAfresh(task);
    if (isTerminal(read)) return read;
  }
  if (!(await callerIsLive(caller))) throw new TaskNotFoundError();
  return readTaskAfresh(task);
};

const startTurn = async (
  caller: A2aCaller,
  params: SendMessageRequest,
): Promise<StartedTurn> => {
  const { endpoint, token } = caller;
  const message: Message | undefined = params.message;
  if (!message?.messageId) {
    throw new RequestMalformedError("A message with a messageId is required");
  }
  if (message.role !== Role.ROLE_USER) {
    throw new RequestMalformedError("A message's role must be ROLE_USER");
  }
  checkHistoryLength(params.configuration?.historyLength);
  if (message.parts.length === 0) {
    throw new RequestMalformedError("A message needs at least one part");
  }
  const parts = message.parts.map(fromA2aPart);
  const contextId = message.contextId || undefined;
  if (contextId && contextId.length > MAX_CONTEXT_ID_LENGTH) {
    throw new RequestMalformedError(
      `A contextId may be at most ${MAX_CONTEXT_ID_LENGTH} characters`,
    );
  }
  if (message.taskId) {
    const task = await findA2aTask(caller, message.taskId);
    if (contextId && contextId !== taskContextId(task)) {
      throw new RequestMalformedError("The contextId is not the Task's");
    }
    if (!isTerminal(await readTask(task))) {
      throw new A2aChatBusyError(task.id);
    }
    throw new UnsupportedOperationError(
      "The Task has ended. Send with its contextId, and no taskId, to continue",
    );
  }
  // why: checked before the run starts, so a refused config starts nothing
  const push =
    params.configuration?.taskPushNotificationConfig &&
    checkPushConfig(params.configuration.taskPushNotificationConfig);
  const withPush = async (task: TaskRow) => {
    if (!push) return task;
    await taskStatus(task);
    await storePushConfig(task, push);
    return task;
  };

  let context: TurnContext;
  let parentId: string | null = null;
  if (contextId) {
    const mintedChatId = a2aContextChatId(token.id, contextId);
    const chats = await db
      .select({
        id: chatTable.id,
        leafId: chatTable.activeLeafId,
        status: chatTable.status,
        runHeartbeatAt: chatTable.runHeartbeatAt,
        lastTurnAt: chatTable.lastTurnAt,
        updatedAt: chatTable.updatedAt,
      })
      .from(chatTable)
      .where(
        and(
          inArray(chatTable.id, [contextId, mintedChatId]),
          eq(chatTable.workspaceId, endpoint.workspaceId),
          eq(chatTable.agentId, endpoint.agentId),
          eq(chatTable.a2aTokenId, token.id),
        ),
      );
    const chat = chats.find((row) => row.id === contextId) ?? chats[0];
    context =
      chat?.id === contextId
        ? { chatId: contextId, contextId: null }
        : { chatId: mintedChatId, contextId };
    if (chat) {
      const [sent] = await db
        .select({ id: chatMessage.id })
        .from(chatMessage)
        .where(
          and(
            eq(chatMessage.chatId, chat.id),
            eq(chatMessage.id, message.messageId),
          ),
        )
        .limit(1);
      if (sent) {
        return {
          task: await withPush(await taskFor(caller, context, sent.id)),
        };
      }
      if (chatRunIsLive(chat)) throw await busyError(caller, chat.id);
      parentId = chat.leafId;
    }
  } else {
    const [opened] = await db
      .select({ chatId: chatMessage.chatId })
      .from(chatMessage)
      .innerJoin(chatTable, eq(chatTable.id, chatMessage.chatId))
      .where(
        and(
          eq(chatTable.a2aTokenId, token.id),
          eq(chatMessage.id, message.messageId),
        ),
      )
      .limit(1);
    if (opened) {
      return {
        task: await withPush(
          await taskFor(
            caller,
            { chatId: opened.chatId, contextId: null },
            message.messageId,
          ),
        ),
      };
    }
    context = {
      chatId: a2aChatId(token.id, message.messageId),
      contextId: null,
    };
  }

  const { chatId } = context;
  const scope = workspaceScopeForA2a({
    endpointId: endpoint.id,
    tokenId: token.id,
    tokenName: token.name,
    workspaceId: endpoint.workspaceId,
    organizationId: endpoint.organizationId,
    ownerUserId: endpoint.ownerId,
  });
  // why: taken just before the try, so every way out of it gives the slot back
  const release = acquireA2aRunSlot();
  if (!release) throw new A2aAtCapacityError();
  let run: ReadableStream<Uint8Array> | undefined;
  // why: made with the claim, so no call sees the Chat running without its Task
  let task: TaskRow | undefined;
  try {
    const response = await startChatTurn({
      scope,
      chatId,
      request: {
        trigger: "submit",
        agentId: endpoint.agentId,
        message: { id: message.messageId, role: "user", parts },
        parentId,
      },
      includeMemories: endpoint.includeMemories,
      origin: caller.origin,
      newChat: {
        agentId: endpoint.agentId,
        a2aTokenId: token.id,
        a2aClientName: token.name,
        a2aEndpointId: endpoint.id,
      },
      onEnded: release,
      onClaimed: async (tx) => {
        task = await insertTask(tx, caller, context, message.messageId);
      },
    });
    run = response.body ?? undefined;
  } catch (error) {
    release();
    if (error instanceof ConflictError) {
      const started = await findTask(
        and(
          eq(a2aTaskTable.chatId, chatId),
          eq(a2aTaskTable.messageId, message.messageId),
          eq(a2aTaskTable.tokenId, token.id),
        ),
      );
      if (started) return { task: await withPush(started) };
      throw await busyError(caller, chatId);
    }
    if (error instanceof ValidationError) {
      throw new RequestMalformedError(error.message);
    }
    throw error;
  }

  try {
    if (!task) throw new Error("The turn started without its Task");
    const started = await withPush(task);
    return {
      task: started,
      events: run && produceA2aTaskEvents(started, run),
    };
  } catch (error) {
    await run?.cancel();
    throw error;
  }
};

type StartedTurn = { task: TaskRow; events?: A2aTaskSubscription };

const startingTurns = new Map<string, Promise<unknown>>();

export const startA2aTurn = async (
  caller: A2aCaller,
  params: SendMessageRequest,
): Promise<StartedTurn> => {
  const key = JSON.stringify([
    caller.token.id,
    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- an empty string falls back too
    params.message?.contextId || null,
    params.message?.messageId ?? null,
  ]);
  for (
    let starting = startingTurns.get(key);
    starting;
    starting = startingTurns.get(key)
  ) {
    await starting.catch(() => undefined);
  }
  const started = startTurn(caller, params);
  startingTurns.set(key, started);
  try {
    return await started;
  } finally {
    if (startingTurns.get(key) === started) startingTurns.delete(key);
  }
};

export const sendA2aMessage = async (
  caller: A2aCaller,
  params: SendMessageRequest,
): Promise<Task> => {
  const deadline = Date.now() + A2A_BLOCKING_WAIT_MS;
  const { task, events: started } = await startA2aTurn(caller, params);
  if (params.configuration?.returnImmediately) {
    started?.close();
    return readTask(task);
  }
  // why: subscribed before the read, so an end published as it reads is not missed
  const events = started ?? a2aTaskEvents.subscribe(task.id);
  try {
    if (started) return await waitForTask(caller, task, deadline, events);
    const read = await readTask(task);
    if (isTerminal(read)) return read;
    const release = takeFollowerSlot(caller);
    try {
      return await waitForTask(caller, task, deadline, events);
    } finally {
      release();
    }
  } finally {
    events.close();
  }
};

const checkHistoryLength = (historyLength: number | undefined) => {
  if (
    historyLength !== undefined &&
    !(Number.isInteger(historyLength) && historyLength >= 0)
  ) {
    throw new RequestMalformedError(
      "historyLength must be a non-negative integer",
    );
  }
};

export const getA2aTask = async (
  caller: A2aCaller,
  params: GetTaskRequest,
): Promise<Task> => {
  checkHistoryLength(params.historyLength);
  return readTokenTask(
    { endpointId: caller.endpoint.id, tokenId: caller.token.id },
    params.id,
  );
};

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

const pageTokenOf = (caller: A2aCaller, task: TaskRow): string =>
  Buffer.from(
    JSON.stringify([caller.token.id, task.statusAt.toISOString(), task.id]),
  ).toString("base64url");

const readPageToken = (caller: A2aCaller, token: string): TaskRowCursor => {
  try {
    const [tokenId, at, id] = JSON.parse(
      Buffer.from(token, "base64url").toString(),
    ) as unknown[];
    if (
      tokenId === caller.token.id &&
      typeof at === "string" &&
      typeof id === "string"
    ) {
      const date = new Date(at);
      if (!Number.isNaN(date.getTime())) return { at: date, id };
    }
  } catch {
    throw invalidPageToken();
  }
  throw invalidPageToken();
};

const invalidPageToken = () =>
  new RequestMalformedError("pageToken is not a valid page token");

// why: only a running Chat can hold a Task with no recorded end that still matches a status, so this reads a Chat's live turns, not the token's backlog
const derivedTaskIds = async (
  caller: A2aCaller,
  status: TaskState,
): Promise<string[]> => {
  const readings = await readTaskRows(
    and(
      eq(a2aTaskTable.tokenId, caller.token.id),
      isNull(a2aTaskTable.state),
      eq(chatTable.status, "running"),
    ),
  );
  return readings.flatMap((reading) =>
    derivedTaskStatus(reading).state === status ? [reading.id] : [],
  );
};

export const listA2aTasks = async (
  caller: A2aCaller,
  params: ListTasksRequest,
): Promise<ListTasksResponse> => {
  const pageSize = params.pageSize ?? DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
    throw new RequestMalformedError(
      `pageSize must be between 1 and ${MAX_PAGE_SIZE}`,
    );
  }
  checkHistoryLength(params.historyLength);
  if (params.status === TaskState.UNRECOGNIZED) {
    throw new RequestMalformedError("status is not a Task state");
  }
  const after = params.statusTimestampAfter
    ? new Date(params.statusTimestampAfter)
    : undefined;
  if (after && Number.isNaN(after.getTime())) {
    throw new RequestMalformedError(
      "statusTimestampAfter is not an ISO 8601 timestamp",
    );
  }
  const cursor = params.pageToken
    ? readPageToken(caller, params.pageToken)
    : undefined;

  const mine = eq(a2aTaskTable.tokenId, caller.token.id);
  const recorded = params.status ? endStateOf(params.status) : undefined;
  const derived = params.status
    ? await derivedTaskIds(caller, params.status)
    : [];

  // why: an empty or() matches everything, so a state no Task is in returns no page here
  if (params.status && !recorded && !derived.length) {
    return { tasks: [], nextPageToken: "", pageSize, totalSize: 0 };
  }
  const filters = and(
    mine,
    params.contextId ? isTaskContext(params.contextId) : undefined,
    params.status
      ? or(
          recorded ? eq(a2aTaskTable.state, recorded) : undefined,
          derived.length ? inArray(a2aTaskTable.id, derived) : undefined,
        )
      : undefined,
    after ? gte(a2aTaskTable.statusAt, after) : undefined,
  );

  const { total } = oneRow(
    await db.select({ total: count() }).from(a2aTaskTable).where(filters),
  );
  const rows = await readTaskPage(filters, {
    after: cursor,
    limit: pageSize + 1,
  });
  // why: a Task's status comes from its page row, so this reads only the page
  const page = rows.slice(0, pageSize).map((row) => ({
    ...row,
    status: derivedTaskStatus(row),
  }));
  const last = page.at(-1);
  const replies = await recordedReplies(page, {
    withText: !!params.includeArtifacts,
  });

  return {
    tasks: page.map((task) => {
      const read = toTask(task, task.status, replies.get(task.id));
      return params.includeArtifacts ? read : { ...read, artifacts: [] };
    }),
    nextPageToken:
      rows.length > pageSize && last ? pageTokenOf(caller, last) : "",
    pageSize,
    totalSize: total,
  };
};
