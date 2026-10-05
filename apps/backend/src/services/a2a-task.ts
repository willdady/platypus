import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
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
import { cancelRun } from "../runs/run-cancel.ts";
import { workspaceScopeForA2a } from "../scope.ts";
import { startChatTurn } from "./chat-turn.ts";
import type { LiveA2aEndpoint } from "./a2a-endpoint.ts";
import {
  currentTurnId,
  readTask,
  recordTaskEnd,
  TERMINAL_TASK_STATES,
  type TaskRow,
} from "./a2a-task-state.ts";
import {
  checkPushConfig,
  pushA2aChatEnded,
  storePushConfig,
} from "./a2a-push.ts";
import { A2aAtCapacityError, acquireA2aRunSlot } from "./a2a-call.ts";

/**
 * A2A conversations (ADR-0032): `SendMessage` starts a turn in a Chat and
 * answers with the turn's Task, which the client follows with `GetTask`. A
 * running Task's state is read from the Chat's run on every call, and an
 * ended one's from the Task, so any backend instance answers.
 */

export type A2aCaller = {
  endpoint: LiveA2aEndpoint;
  token: { id: string; name: string };
  origin: string;
};

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
        text: `Data:\n${JSON.stringify(part.content.value, null, 2)}`,
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

/** The Task for a turn's user message, made the first time it is asked for. */
const taskFor = async (
  caller: A2aCaller,
  chatId: string,
  messageId: string,
  tokenId: string | null,
): Promise<TaskRow> => {
  const where = and(
    eq(a2aTaskTable.chatId, chatId),
    eq(a2aTaskTable.messageId, messageId),
  );
  const existing = await findTask(where);
  if (existing) return existing;
  try {
    const [row] = await db
      .insert(a2aTaskTable)
      .values({
        id: randomUUID(),
        chatId,
        messageId,
        endpointId: caller.endpoint.id,
        tokenId,
        createdAt: new Date(),
      })
      .returning();
    return row;
  } catch (error) {
    // Two calls raced to make it; the other one's is this turn's Task.
    if (!isUniqueViolation(error)) throw error;
    return findTask(where);
  }
};

/**
 * The refusal for a message sent while the Chat's run is still going,
 * carrying that run's Task so the client can follow it. A run the Owner
 * started in the UI gets a Task here, so it can be followed the same way.
 */
const busyError = async (caller: A2aCaller, chatId: string) => {
  const turnId = await currentTurnId(chatId);
  const task = turnId ? await taskFor(caller, chatId, turnId, null) : undefined;
  // Reading it records its end, should its run have ended as it was made.
  if (task) await readTask(task);
  return new UnsupportedOperationError({
    message: CHAT_BUSY_MESSAGE,
    metadata: task ? { taskId: task.id } : undefined,
  });
};

/** The Task once it ends, or as it stands when `deadline` passes. */
const waitForTask = async (task: TaskRow, deadline: number): Promise<Task> => {
  for (;;) {
    const read = await readTask(task);
    if (TERMINAL_TASK_STATES.has(read.status!.state) || Date.now() >= deadline)
      return read;
    await new Promise((resolve) => setTimeout(resolve, BLOCKING_POLL_MS));
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
export const startA2aTurn = async (
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
  // Checked before the run starts, so a refused config starts nothing.
  const push =
    params.configuration?.taskPushNotificationConfig &&
    (await checkPushConfig(params.configuration.taskPushNotificationConfig));
  const withPush = async (task: TaskRow) => {
    if (push) await storePushConfig(task, push);
    return task;
  };

  const contextId = message.contextId || undefined;
  let parentId: string | null = null;
  if (contextId) {
    const [chat] = await db
      .select({ leafId: chatTable.activeLeafId })
      .from(chatTable)
      .where(
        and(
          eq(chatTable.id, contextId),
          eq(chatTable.workspaceId, endpoint.workspaceId),
          eq(chatTable.agentId, endpoint.agentId),
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
        task: await withPush(
          await taskFor(caller, contextId, sent.id, token.id),
        ),
      };
    }
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
          await taskFor(caller, opened.chatId, message.messageId, token.id),
        ),
      };
    }
  }

  const chatId = contextId ?? randomUUID();
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
        a2aEndpointId: endpoint.id,
      },
      onEnded: release,
    });
    run = response.body ?? undefined;
  } catch (error) {
    // No run is left going, or the one that started has already ended.
    release();
    if (error instanceof ConflictError) throw await busyError(caller, chatId);
    if (error instanceof ValidationError) {
      throw new RequestMalformedError(error.message);
    }
    throw error;
  }

  try {
    return {
      task: await withPush(
        await taskFor(caller, chatId, message.messageId, token.id),
      ),
      run,
    };
  } catch (error) {
    await run?.cancel();
    throw error;
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
  return params.configuration?.returnImmediately
    ? readTask(task)
    : waitForTask(task, deadline);
};

/** One of this endpoint's Tasks. */
export const findA2aTask = async (
  caller: A2aCaller,
  taskId: string,
): Promise<TaskRow> => {
  const task = await findTask(
    and(
      eq(a2aTaskTable.id, taskId),
      eq(a2aTaskTable.endpointId, caller.endpoint.id),
    ),
  );
  if (!task) throw new TaskNotFoundError();
  return task;
};

/** `GetTask`: one of this endpoint's Tasks, read from the database. */
export const getA2aTask = async (
  caller: A2aCaller,
  taskId: string,
): Promise<Task> => readTask(await findA2aTask(caller, taskId));

/**
 * `CancelTask`: stops the run of one of this endpoint's Tasks, on whichever
 * instance holds it, and answers with the Task, `canceled`. The end is
 * recorded at once, so every reader and follower sees it even before the run
 * has stopped, and even if the cancel never reaches it. A Task that has
 * already ended is answered as it ended, and nothing is stopped.
 */
export const cancelA2aTask = async (
  caller: A2aCaller,
  taskId: string,
): Promise<Task> => {
  const task = await findA2aTask(caller, taskId);
  const read = await readTask(task);
  if (TERMINAL_TASK_STATES.has(read.status!.state)) return read;
  // A run's id is its Chat's.
  await cancelRun(task.chatId);
  await recordTaskEnd(task.chatId, task.messageId, "cancelled");
  void pushA2aChatEnded(task.chatId);
  return readTask(await findA2aTask(caller, taskId));
};
