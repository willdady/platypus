import { randomUUID } from "node:crypto";
import { v5 as uuidv5 } from "uuid";
import {
  and,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lt,
  lte,
  or,
} from "drizzle-orm";
import {
  TaskState,
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
import {
  CHAT_BUSY_MESSAGE,
  type ChatClaimTx,
} from "../runs/sinks/chat-sink.ts";
import { workspaceScopeForA2a } from "../scope.ts";
import { startChatTurn } from "./chat-turn.ts";
import { callerDataBlock } from "./caller-data.ts";
import type { LiveA2aEndpoint } from "./a2a-endpoint.ts";
import {
  currentTurnId,
  findTokenTask,
  readTask,
  readTaskAfresh,
  endStateOf,
  TERMINAL_TASK_STATES,
  type TaskRow,
} from "./a2a-task-state.ts";
import { checkPushConfig, storePushConfig } from "./a2a-push.ts";
import {
  A2aAtCapacityError,
  acquireA2aFollowerSlot,
  acquireA2aRunSlot,
} from "./a2a-call.ts";
import { callerIsLive } from "./a2a-liveness.ts";

/**
 * A2A conversations (ADR-0032): `SendMessage` starts a turn in a Chat and
 * answers with the turn's Task, which the client follows with `GetTask`. A
 * running Task's state is read from the Chat's run on every call, and an
 * ended one's from the Task, so any backend instance answers.
 */

export type A2aCaller = {
  endpoint: LiveA2aEndpoint;
  /** The token the call carried, as the value it carried was issued. */
  token: { id: string; name: string; tokenCreatedAt: Date };
  origin: string;
  /**
   * Aborted once the client hangs up, so a caller following a Task lets go
   * of its follower slot then, not when the Task next changes.
   */
  signal?: AbortSignal;
};

/** The namespace of the Chat ids `a2aChatId` derives. Fixed for good. */
const A2A_CHAT_NAMESPACE = "0b6f4d2e-6a43-4d8e-9c1a-3f0e2b7d5a91";

/**
 * The id of the Chat a token's message opens when it names no context: a
 * UUIDv5 of the token and the client's `messageId`. Two copies of the message
 * sent at once, to any instances, then race for one Chat, and its claim lets
 * only one of them start the turn.
 */
export const a2aChatId = (tokenId: string, messageId: string): string =>
  uuidv5(JSON.stringify([tokenId, messageId]), A2A_CHAT_NAMESPACE);

/** How long a blocking `SendMessage` waits for its run to end. */
const A2A_BLOCKING_WAIT_MS = 30_000;
const BLOCKING_POLL_MS = 500;

/**
 * An inbound A2A part as a UI message part. Data parts reach the Agent as
 * labelled JSON, as Inbound Trigger inputs do. Anything else is refused:
 * nothing is dropped silently.
 */
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

const findTask = async (where: ReturnType<typeof and>) => {
  const [row] = await db.select().from(a2aTaskTable).where(where).limit(1);
  return row;
};

/** Where a Task is written: the database, or the claim's transaction. */
type Executor = typeof db | ChatClaimTx;

/** Makes the Task for a turn's user message, as the calling token's. */
const insertTask = async (
  executor: Executor,
  caller: A2aCaller,
  chatId: string,
  messageId: string,
): Promise<TaskRow> => {
  const now = new Date();
  const [row] = await executor
    .insert(a2aTaskTable)
    .values({
      id: randomUUID(),
      chatId,
      messageId,
      endpointId: caller.endpoint.id,
      tokenId: caller.token.id,
      statusAt: now,
      createdAt: now,
    })
    .returning();
  return row;
};

/**
 * The Task for a retried turn's user message. The call that started the turn
 * made it with the turn's claim, so it is read as it stands: its token and
 * endpoint are never rewritten. Made here only for a message in the token's
 * Chat that has none.
 */
const taskFor = async (
  caller: A2aCaller,
  chatId: string,
  messageId: string,
): Promise<TaskRow> => {
  const where = and(
    eq(a2aTaskTable.chatId, chatId),
    eq(a2aTaskTable.messageId, messageId),
  );
  const existing = await findTask(where);
  if (existing) return existing;
  try {
    return await insertTask(db, caller, chatId, messageId);
  } catch (error) {
    // Two retries raced to make it; the other one's is this turn's Task.
    if (!isUniqueViolation(error)) throw error;
    return findTask(where);
  }
};

/**
 * The refusal for a message sent while the Chat's run is still going,
 * carrying that run's Task in its error data so the client can follow it.
 * The spec has no error for a busy context; it answers a Task that cannot
 * take a message with "unsupported operation", so this is answered as that.
 */
export class A2aChatBusyError extends UnsupportedOperationError {
  readonly taskId?: string;

  constructor(taskId?: string) {
    super({
      message: CHAT_BUSY_MESSAGE,
      metadata: taskId ? { taskId } : undefined,
    });
    // The transports pick the wire code by name.
    this.name = "UnsupportedOperationError";
    this.taskId = taskId;
  }
}

/**
 * `A2aChatBusyError` for the Chat's running turn, naming its Task when this
 * token started that turn. Only ever asked of a Chat the token started, and
 * it only reads: a turn the Owner started in the UI is answered busy with no
 * Task, so the client cannot follow, or cancel, a run it did not start. A
 * turn this token started has its Task from the moment its claim commits.
 */
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
  // Reading it records its end, should its run have ended as it was found.
  if (task) await readTask(task);
  return new A2aChatBusyError(task?.id);
};

/**
 * Waits `ms`, or less once `signal` aborts: a follower's poll, cut short when
 * its client hangs up.
 */
export const pause = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });

/**
 * A follower slot for a caller about to follow a Task whose run it did not
 * start, or `A2aAtCapacityError` past the follower cap. Returns its release.
 */
export const takeFollowerSlot = (caller: A2aCaller): (() => void) => {
  const release = acquireA2aFollowerSlot(caller.token.id);
  if (!release) {
    throw new A2aAtCapacityError("Too many callers are following A2A Tasks");
  }
  return release;
};

/**
 * The Task once it ends, as it stands when `deadline` passes, or as it stands
 * when the client hangs up. Refused as not found once the caller's access is
 * cut off, as a new call would be.
 */
const waitForTask = async (
  caller: A2aCaller,
  task: TaskRow,
  deadline: number,
): Promise<Task> => {
  for (;;) {
    if (!(await callerIsLive(caller))) throw new TaskNotFoundError();
    const read = await readTaskAfresh(task);
    if (
      TERMINAL_TASK_STATES.has(read.status!.state) ||
      Date.now() >= deadline ||
      caller.signal?.aborted
    )
      return read;
    await pause(BLOCKING_POLL_MS, caller.signal);
  }
};

/**
 * A turn in a new Chat bound to the endpoint's Agent, or in the Chat
 * `contextId` names, and its Task. The client's `messageId` is the user
 * message's id, so a retry finds the Task it already started and starts
 * nothing. `run` is the run's response body when this call started the run;
 * the run goes on server-side whether or not the caller reads it, and a
 * caller that does not must cancel it.
 */
const startTurn = async (
  caller: A2aCaller,
  params: SendMessageRequest,
): Promise<{ task: TaskRow; run?: ReadableStream<Uint8Array> }> => {
  const { endpoint, token } = caller;
  const message: Message | undefined = params.message;
  if (!message?.messageId) {
    throw new RequestMalformedError("A message with a messageId is required");
  }
  if (message.parts.length === 0) {
    throw new RequestMalformedError("A message needs at least one part");
  }
  const parts = message.parts.map(fromA2aPart);
  // A Task is one turn and takes no more messages, so a message naming one
  // never starts a run. It is refused with the spec's error for the case.
  if (message.taskId) {
    const task = await findA2aTask(caller, message.taskId);
    if (message.contextId && message.contextId !== task.chatId) {
      throw new RequestMalformedError("The contextId is not the Task's");
    }
    const { status } = await readTask(task);
    if (!TERMINAL_TASK_STATES.has(status!.state)) {
      throw new A2aChatBusyError(task.id);
    }
    throw new UnsupportedOperationError(
      "The Task has ended. Send with its contextId, and no taskId, to continue",
    );
  }
  // Checked before the run starts, so a refused config starts nothing.
  const push =
    params.configuration?.taskPushNotificationConfig &&
    checkPushConfig(params.configuration.taskPushNotificationConfig);
  const withPush = async (task: TaskRow) => {
    if (push) await storePushConfig(task, push);
    return task;
  };

  const contextId = message.contextId || undefined;
  let parentId: string | null = null;
  if (contextId) {
    // Only a Chat this token started (ADR-0032). The Owner's own Chats,
    // another token's and another endpoint's are answered as an unknown id:
    // a Chat id is no secret, so it is not a credential.
    const [chat] = await db
      .select({ leafId: chatTable.activeLeafId, status: chatTable.status })
      .from(chatTable)
      .where(
        and(
          eq(chatTable.id, contextId),
          eq(chatTable.workspaceId, endpoint.workspaceId),
          eq(chatTable.agentId, endpoint.agentId),
          eq(chatTable.a2aTokenId, token.id),
        ),
      )
      .limit(1);
    if (!chat) throw new TaskNotFoundError("Context not found");
    const [sent] = await db
      .select({ id: chatMessage.id })
      .from(chatMessage)
      .where(
        and(
          eq(chatMessage.chatId, contextId),
          eq(chatMessage.id, message.messageId),
        ),
      )
      .limit(1);
    if (sent) {
      return {
        task: await withPush(await taskFor(caller, contextId, sent.id)),
      };
    }
    // Before the slot is taken, so a busy Chat is answered with its Task at
    // any load. The claim in the run still refuses one that turns busy after.
    if (chat.status === "running") throw await busyError(caller, contextId);
    parentId = chat.leafId;
  } else {
    // A retry of the message that opened a Chat names no context yet: find
    // it in a Chat this token started. Read from the message, which the run
    // writes before anything else, so a retry mid-start never runs twice.
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
          await taskFor(caller, opened.chatId, message.messageId),
        ),
      };
    }
  }

  const chatId = contextId ?? a2aChatId(token.id, message.messageId);
  const scope = workspaceScopeForA2a({
    endpointId: endpoint.id,
    tokenId: token.id,
    tokenName: token.name,
    workspaceId: endpoint.workspaceId,
    organizationId: endpoint.organizationId,
    ownerUserId: endpoint.ownerId,
  });
  // Asked only by a call that would start a run: a retry above answers with
  // its Task at any load. Past the cap, nothing has been written. Taken just
  // before the `try`, so every way out of it gives the slot back.
  const release = acquireA2aRunSlot();
  if (!release) throw new A2aAtCapacityError();
  let run: ReadableStream<Uint8Array> | undefined;
  // Made with the claim, so the Task is this call's from the moment any other
  // call can see the Chat running, and a Task that cannot be made starts no
  // run.
  let task: TaskRow | undefined;
  try {
    const response = await startChatTurn({
      scope,
      request: {
        id: chatId,
        workspaceId: endpoint.workspaceId,
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
        task = await insertTask(tx, caller, chatId, message.messageId);
      },
    });
    run = response.body ?? undefined;
  } catch (error) {
    // No run is left going, or the one that started has already ended.
    release();
    if (error instanceof ConflictError) {
      // A copy of this message at another instance started the turn first.
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
    return { task: await withPush(task), run };
  } catch (error) {
    await run?.cancel();
    throw error;
  }
};

/**
 * The turns this instance is starting, by token, context and message. A copy
 * of a message that arrives while its first copy is still starting here waits
 * for that start to settle, then finds its Task as a retry does. A copy at
 * another instance is refused by the claim instead.
 */
const startingTurns = new Map<string, Promise<unknown>>();

/**
 * A turn in a new Chat bound to the endpoint's Agent, or in the Chat
 * `contextId` names, and its Task (see `startTurn`), started once however
 * many copies of the message arrive at once.
 */
export const startA2aTurn = async (
  caller: A2aCaller,
  params: SendMessageRequest,
): Promise<{ task: TaskRow; run?: ReadableStream<Uint8Array> }> => {
  const key = JSON.stringify([
    caller.token.id,
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

/**
 * `SendMessage`: the turn's Task once its run has started, or once it ends if
 * the client asked to block and it ends soon enough.
 */
export const sendA2aMessage = async (
  caller: A2aCaller,
  params: SendMessageRequest,
): Promise<Task> => {
  const deadline = Date.now() + A2A_BLOCKING_WAIT_MS;
  const { task, run } = await startA2aTurn(caller, params);
  // The client follows the run by Task, not by this stream.
  await run?.cancel();
  if (params.configuration?.returnImmediately) return readTask(task);
  // The call that started the run waits on its run slot. A retry waits on a
  // follower slot, unless its Task has already ended and there is nothing to
  // wait for.
  if (run) return waitForTask(caller, task, deadline);
  const read = await readTask(task);
  if (TERMINAL_TASK_STATES.has(read.status!.state)) return read;
  const release = takeFollowerSlot(caller);
  try {
    return await waitForTask(caller, task, deadline);
  } finally {
    release();
  }
};

/** One of the Tasks the calling token started; any other is not found. */
export const findA2aTask = (
  caller: A2aCaller,
  taskId: string,
): Promise<TaskRow> =>
  findTokenTask(
    { endpointId: caller.endpoint.id, tokenId: caller.token.id },
    taskId,
  );

/** `GetTask`: one of the calling token's Tasks, read from the database. */
export const getA2aTask = async (
  caller: A2aCaller,
  taskId: string,
): Promise<Task> => readTask(await findA2aTask(caller, taskId));

/** How many Tasks a `ListTasks` page holds, unless the client asks. */
const DEFAULT_PAGE_SIZE = 50;
/** The most a client may ask for in one page. */
const MAX_PAGE_SIZE = 100;

/**
 * A page token: the status timestamp and id of the page's last Task, and the
 * token that listed it. Another token's page token is refused, not followed.
 */
const pageTokenOf = (caller: A2aCaller, task: TaskRow): string =>
  Buffer.from(
    JSON.stringify([caller.token.id, task.statusAt.toISOString(), task.id]),
  ).toString("base64url");

const readPageToken = (
  caller: A2aCaller,
  token: string,
): { at: Date; id: string } => {
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
    // Not one of ours; refused below.
  }
  throw new RequestMalformedError("pageToken is not a valid page token");
};

/**
 * `ListTasks`: the Tasks the calling token started on this endpoint, newest
 * status first. The same scope as every other Task method: a token reaches
 * only its own Tasks (ADR-0032). A deleted token's Tasks are listed to no one.
 *
 * Each running Task's state is read from its run first, recording any end
 * not yet recorded, so the `status` filter and the order see where it is now.
 *
 * ponytail: every call reads all of the token's Tasks with no end recorded.
 * Few, unless runs end unrecorded en masse; a sweep that records them is the
 * upgrade.
 */
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

  const mine = and(
    eq(a2aTaskTable.endpointId, caller.endpoint.id),
    eq(a2aTaskTable.tokenId, caller.token.id),
  );
  const unended = await db
    .select()
    .from(a2aTaskTable)
    .where(and(mine, isNull(a2aTaskTable.state)));
  const running = new Map(
    (await Promise.all(unended.map(readTask))).map((task) => [task.id, task]),
  );

  // A state no Task here is in — one we never use, or no run is in — is
  // matched by nothing, rather than by everything an empty `or` would allow.
  const live = [...running.values()]
    .filter((task) => task.status!.state === params.status)
    .map((task) => task.id);
  const recorded = endStateOf(params.status);
  if (params.status && !recorded && !live.length) {
    return { tasks: [], nextPageToken: "", pageSize, totalSize: 0 };
  }
  const filters = and(
    mine,
    params.contextId ? eq(a2aTaskTable.chatId, params.contextId) : undefined,
    params.status
      ? or(
          recorded ? eq(a2aTaskTable.state, recorded) : undefined,
          live.length ? inArray(a2aTaskTable.id, live) : undefined,
        )
      : undefined,
    after ? gt(a2aTaskTable.statusAt, after) : undefined,
  );

  const [{ total }] = await db
    .select({ total: count() })
    .from(a2aTaskTable)
    .where(filters);
  const rows = await db
    .select()
    .from(a2aTaskTable)
    .where(
      and(
        filters,
        cursor
          ? or(
              lt(a2aTaskTable.statusAt, cursor.at),
              and(
                lte(a2aTaskTable.statusAt, cursor.at),
                lt(a2aTaskTable.id, cursor.id),
              ),
            )
          : undefined,
      ),
    )
    .orderBy(desc(a2aTaskTable.statusAt), desc(a2aTaskTable.id))
    .limit(pageSize + 1);
  const page = rows.slice(0, pageSize);

  const tasks = await Promise.all(
    page.map(async (row) => running.get(row.id) ?? readTask(row)),
  );
  return {
    tasks: params.includeArtifacts
      ? tasks
      : tasks.map((task) => ({ ...task, artifacts: [] })),
    nextPageToken:
      rows.length > pageSize ? pageTokenOf(caller, page[page.length - 1]) : "",
    pageSize,
    totalSize: total,
  };
};
