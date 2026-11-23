import { and, eq, gt, inArray, isNotNull, isNull } from "drizzle-orm";
import type { Task } from "@a2a-js/sdk";
import { TaskNotCancelableError } from "@a2a-js/sdk/errors";
import { db } from "../index.ts";
import { a2aTask as a2aTaskTable, chat as chatTable } from "../db/schema.ts";
import { logger } from "../logger.ts";
import { runRegistry } from "../runs/run-registry.ts";
import type { A2aCaller } from "./a2a-task.ts";
import { currentTurnId, findA2aTask, type TaskRow } from "./a2a-task-state.ts";
import { cancelTask, readTask } from "./a2a-task-lifecycle.ts";
import { taskIsLive } from "./a2a-liveness.ts";

const SWEEP_MS = 5_000;

const isCurrentTurn = async (task: Pick<TaskRow, "chatId" | "messageId">) =>
  (await currentTurnId(task.chatId)) === task.messageId;

export const cancelA2aTask = async (
  caller: A2aCaller,
  taskId: string,
): Promise<Task> => {
  const claimed = await cancelTask(await findA2aTask(caller, taskId));
  if (!claimed) throw new TaskNotCancelableError();
  return readTask(claimed);
};

const cancelRevoked = async (tasks: TaskRow[]): Promise<void> => {
  for (const task of tasks) {
    if (!(await taskIsLive(task))) await cancelTask(task);
  }
};

export const stopRevokedA2aWork = async (
  endpointIds: string[],
): Promise<void> => {
  if (endpointIds.length === 0) return;
  try {
    // why: by the Chat, whose endpoint id outlives the endpoint; the Task's is nulled with it
    const running = await db
      .select()
      .from(a2aTaskTable)
      .innerJoin(chatTable, eq(chatTable.id, a2aTaskTable.chatId))
      .where(
        and(
          inArray(chatTable.a2aEndpointId, endpointIds),
          isNull(a2aTaskTable.state),
        ),
      );
    await cancelRevoked(running.map((row) => row.a2a_task));
  } catch (error) {
    logger.error(
      { error, endpointIds },
      "Stopping a revoked client's A2A Tasks failed",
    );
  }
};

export const stopRevokedA2aRuns = async (): Promise<void> => {
  const held = runRegistry.heldRuns();
  if (held.length === 0) return;
  const running = await db
    .select()
    .from(a2aTaskTable)
    .where(
      and(
        inArray(
          a2aTaskTable.chatId,
          held.map((run) => run.runId),
        ),
        isNull(a2aTaskTable.state),
      ),
    );
  await cancelRevoked(running);
};

export const stopCanceledA2aRuns = async (): Promise<void> => {
  const held = runRegistry.heldRuns();
  if (held.length === 0) return;
  const oldest = Math.min(...held.map((run) => run.startedAt));
  const canceled = await db
    .select({
      chatId: a2aTaskTable.chatId,
      messageId: a2aTaskTable.messageId,
      canceledAt: a2aTaskTable.canceledAt,
    })
    .from(a2aTaskTable)
    .where(
      and(
        inArray(
          a2aTaskTable.chatId,
          held.map((run) => run.runId),
        ),
        isNotNull(a2aTaskTable.canceledAt),
        gt(a2aTaskTable.canceledAt, new Date(oldest - 1)),
      ),
    );
  for (const task of canceled) {
    const { canceledAt } = task;
    if (!canceledAt)
      throw new Error(
        `Canceled Task in Chat '${task.chatId}' has no canceledAt`,
      );
    if (!(await isCurrentTurn(task))) continue;
    runRegistry.cancel(task.chatId, {
      startedBefore: canceledAt.getTime(),
    });
  }
};

export const watchForCanceledA2aRuns = (): (() => void) => {
  const timer = setInterval(() => {
    stopCanceledA2aRuns().catch((error: unknown) =>
      logger.error({ error }, "Sweeping canceled A2A runs failed"),
    );
    stopRevokedA2aRuns().catch((error: unknown) =>
      logger.error({ error }, "Sweeping revoked A2A runs failed"),
    );
  }, SWEEP_MS).unref();
  return () => clearInterval(timer);
};
