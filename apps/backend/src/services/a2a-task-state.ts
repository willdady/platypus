import { and, asc, eq, isNull } from "drizzle-orm";
import { TaskState, type Part, type Task } from "@a2a-js/sdk";
import { db } from "../index.ts";
import {
  a2aTask as a2aTaskTable,
  chat as chatTable,
  chatMessage,
  type A2aTaskEndState,
} from "../db/schema.ts";
import type { RunStatus } from "../runs/types.ts";

/**
 * An A2A Task as a client reads it (ADR-0032). While its run is going, its
 * state is read from its Chat's run every time, so any backend instance
 * answers alike. When the run ends, how it ended is recorded on the Task: the
 * Chat can move on to another turn, and then no longer has it.
 */

export type TaskRow = typeof a2aTaskTable.$inferSelect;

/** A text part of an outbound A2A message or artifact. */
const a2aTextPart = (text: string): Part => ({
  content: { $case: "text", value: text },
  metadata: undefined,
  filename: "",
  mediaType: "text/plain",
});

/** A finished run's Chat status as the end a Task records. */
const END_OF_RUN: Partial<Record<string, A2aTaskEndState>> = {
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

/**
 * Records how the turn answering `messageId` ended on its Task, if it has
 * one. The first end recorded stands: a later regenerate of the same turn
 * writes a reply the Task does not read.
 */
export const recordTaskEnd = async (
  chatId: string,
  messageId: string,
  status: RunStatus,
): Promise<void> => {
  const state = END_OF_RUN[status];
  if (!state) return;
  await db
    .update(a2aTaskTable)
    .set({ state })
    .where(
      and(
        eq(a2aTaskTable.chatId, chatId),
        eq(a2aTaskTable.messageId, messageId),
        isNull(a2aTaskTable.state),
      ),
    );
};

/**
 * The user message the Chat's current turn answers: its active leaf, or the
 * leaf's parent when the leaf is the reply.
 */
export const currentTurnId = async (
  chatId: string,
): Promise<string | undefined> => {
  const [chat] = await db
    .select({ leafId: chatTable.activeLeafId })
    .from(chatTable)
    .where(eq(chatTable.id, chatId))
    .limit(1);
  if (!chat?.leafId) return undefined;
  const [leaf] = await db
    .select({ role: chatMessage.role, parentId: chatMessage.parentId })
    .from(chatMessage)
    .where(and(eq(chatMessage.chatId, chatId), eq(chatMessage.id, chat.leafId)))
    .limit(1);
  if (!leaf) return undefined;
  return leaf.role === "assistant" ? (leaf.parentId ?? undefined) : chat.leafId;
};

/**
 * The Task as the client reads it. Once its run has ended, its state is the
 * end recorded on it. Before that it comes from the Chat's run: `submitted`
 * until the reply's first write and `working` after. The final assistant
 * text is the Task's artifact.
 */
export const readTask = async (task: TaskRow): Promise<Task> => {
  const [chat] = task.state
    ? []
    : await db
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
  const state = task.state
    ? STATE_OF_END[task.state]
    : !isThisTurn
      ? // Moved past with no end recorded: one that ended before its Task
        // was made. Its reply, if any, is the best evidence of how.
        reply
        ? TaskState.TASK_STATE_COMPLETED
        : TaskState.TASK_STATE_FAILED
      : chat.status === "running"
        ? reply
          ? TaskState.TASK_STATE_WORKING
          : TaskState.TASK_STATE_SUBMITTED
        : STATE_OF_END[END_OF_RUN[chat.status] ?? "failed"];

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

export const TERMINAL_TASK_STATES = new Set([
  TaskState.TASK_STATE_COMPLETED,
  TaskState.TASK_STATE_FAILED,
  TaskState.TASK_STATE_CANCELED,
]);
