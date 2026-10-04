import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull } from "drizzle-orm";
import {
  TaskState,
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
import type { LiveA2aEndpoint } from "./a2a-endpoint.ts";

/**
 * A2A conversations (ADR-0032): `SendMessage` starts a turn in a Chat and
 * answers with the turn's Task, which the client follows with `GetTask`. A
 * Task's state is read from the Chat's run on every call, so any backend
 * instance answers.
 */

export type A2aCaller = {
  endpoint: LiveA2aEndpoint;
  token: { id: string; name: string };
  origin: string;
};

/** How long a blocking `SendMessage` waits for its run to end. */
const A2A_BLOCKING_WAIT_MS = 30_000;
const BLOCKING_POLL_MS = 500;

type TaskRow = typeof a2aTaskTable.$inferSelect;

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
  const [chat] = await db
    .select({ leafId: chatTable.activeLeafId })
    .from(chatTable)
    .where(eq(chatTable.id, chatId))
    .limit(1);
  const [leaf] = chat?.leafId
    ? await db
        .select({
          id: chatMessage.id,
          role: chatMessage.role,
          parentId: chatMessage.parentId,
        })
        .from(chatMessage)
        .where(
          and(eq(chatMessage.chatId, chatId), eq(chatMessage.id, chat.leafId)),
        )
        .limit(1)
    : [];
  const turnId = leaf?.role === "assistant" ? leaf.parentId : leaf?.id;
  const task = turnId ? await taskFor(caller, chatId, turnId, null) : undefined;
  return new UnsupportedOperationError({
    message: CHAT_BUSY_MESSAGE,
    metadata: task ? { taskId: task.id } : undefined,
  });
};

/** A text part of an outbound A2A message or artifact. */
const a2aTextPart = (text: string): Part => ({
  content: { $case: "text", value: text },
  metadata: undefined,
  filename: "",
  mediaType: "text/plain",
});

/** A finished run's Chat status as a Task state. */
const STATE_OF_RUN: Record<string, TaskState> = {
  succeeded: TaskState.TASK_STATE_COMPLETED,
  failed: TaskState.TASK_STATE_FAILED,
  cancelled: TaskState.TASK_STATE_CANCELED,
};

/**
 * The Task as the client reads it. Its state comes from the Chat's run:
 * while the Chat is running this turn it is `submitted` until the reply's
 * first write and `working` after; once the run ends, the Chat's terminal
 * status. The final assistant text is the Task's artifact.
 */
const readTask = async (task: TaskRow): Promise<Task> => {
  const [chat] = await db
    .select({ status: chatTable.status, leafId: chatTable.activeLeafId })
    .from(chatTable)
    .where(eq(chatTable.id, task.chatId))
    .limit(1);
  // The reply this turn wrote: the first assistant message under it. A later
  // one is a regenerate the Owner ran in the UI.
  const [reply] = await db
    .select({ id: chatMessage.id, parts: chatMessage.parts })
    .from(chatMessage)
    .where(
      and(
        eq(chatMessage.chatId, task.chatId),
        eq(chatMessage.parentId, task.messageId),
        eq(chatMessage.role, "assistant"),
        isNull(chatMessage.deletedAt),
      ),
    )
    .orderBy(asc(chatMessage.createdAt))
    .limit(1);

  const isThisTurn =
    chat?.leafId === task.messageId ||
    (reply !== undefined && chat?.leafId === reply.id);
  // ponytail: a turn the Chat has moved past (the Owner continued it) no
  // longer has its run's status, so a reply reads as completed. Store the
  // terminal state on the Task if clients need it exact.
  const state = !isThisTurn
    ? reply
      ? TaskState.TASK_STATE_COMPLETED
      : TaskState.TASK_STATE_FAILED
    : chat.status === "running"
      ? reply
        ? TaskState.TASK_STATE_WORKING
        : TaskState.TASK_STATE_SUBMITTED
      : (STATE_OF_RUN[chat.status] ?? TaskState.TASK_STATE_FAILED);

  const text =
    state === TaskState.TASK_STATE_COMPLETED && reply
      ? (reply.parts as { type: string; text?: string }[])
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n\n")
      : "";

  return {
    id: task.id,
    contextId: task.chatId,
    status: { state, message: undefined, timestamp: undefined },
    artifacts:
      text && reply
        ? [
            {
              artifactId: reply.id,
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

const TERMINAL = new Set([
  TaskState.TASK_STATE_COMPLETED,
  TaskState.TASK_STATE_FAILED,
  TaskState.TASK_STATE_CANCELED,
]);

/** The Task once it ends, or as it stands when `deadline` passes. */
const waitForTask = async (task: TaskRow, deadline: number): Promise<Task> => {
  for (;;) {
    const read = await readTask(task);
    if (TERMINAL.has(read.status!.state) || Date.now() >= deadline) return read;
    await new Promise((resolve) => setTimeout(resolve, BLOCKING_POLL_MS));
  }
};

/**
 * `SendMessage`: a turn in a new Chat bound to the endpoint's Agent, or in the
 * Chat `contextId` names. The client's `messageId` is the user message's id,
 * so a retry answers with the Task it already started.
 */
export const sendA2aMessage = async (
  caller: A2aCaller,
  params: SendMessageRequest,
): Promise<Task> => {
  const { endpoint, token } = caller;
  const message: Message | undefined = params.message;
  if (!message?.messageId) {
    throw new RequestMalformedError("A message with a messageId is required");
  }
  if (message.parts.length === 0) {
    throw new RequestMalformedError("A message needs at least one part");
  }
  const parts = message.parts.map(fromA2aPart);
  const blocking = !params.configuration?.returnImmediately;
  const deadline = Date.now() + A2A_BLOCKING_WAIT_MS;
  const answer = (task: TaskRow) =>
    blocking ? waitForTask(task, deadline) : readTask(task);

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
      return answer(await taskFor(caller, contextId, sent.id, token.id));
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
      return answer(
        await taskFor(caller, opened.chatId, message.messageId, token.id),
      );
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
    });
    // The run goes on server-side; the client follows it by Task, not by
    // this stream.
    await response.body?.cancel();
  } catch (error) {
    if (error instanceof ConflictError) throw await busyError(caller, chatId);
    if (error instanceof ValidationError) {
      throw new RequestMalformedError(error.message);
    }
    throw error;
  }

  return answer(await taskFor(caller, chatId, message.messageId, token.id));
};

/** `GetTask`: one of this endpoint's Tasks, read from the database. */
export const getA2aTask = async (
  caller: A2aCaller,
  taskId: string,
): Promise<Task> => {
  const task = await findTask(
    and(
      eq(a2aTaskTable.id, taskId),
      eq(a2aTaskTable.endpointId, caller.endpoint.id),
    ),
  );
  if (!task) throw new TaskNotFoundError();
  return readTask(task);
};
