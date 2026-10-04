import { and, asc, eq, isNull } from "drizzle-orm";
import { TaskState, type Part, type Task } from "@a2a-js/sdk";
import { db } from "../index.ts";
import {
  a2aTask as a2aTaskTable,
  chat as chatTable,
  chatMessage,
} from "../db/schema.ts";

/**
 * An A2A Task as a client reads it (ADR-0032). Nothing about a Task's
 * progress is stored on it: its state is read from its Chat's run every time,
 * so any backend instance answers alike.
 */

export type TaskRow = typeof a2aTaskTable.$inferSelect;

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
export const readTask = async (task: TaskRow): Promise<Task> => {
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

export const TERMINAL_TASK_STATES = new Set([
  TaskState.TASK_STATE_COMPLETED,
  TaskState.TASK_STATE_FAILED,
  TaskState.TASK_STATE_CANCELED,
]);
