import { and, eq, gt, inArray, isNotNull, isNull } from "drizzle-orm";
import type { Task } from "@a2a-js/sdk";
import { db } from "../index.ts";
import { a2aTask as a2aTaskTable } from "../db/schema.ts";
import { logger } from "../logger.ts";
import { cancelRun } from "../runs/run-cancel.ts";
import { runRegistry } from "../runs/run-registry.ts";
import { findA2aTask, type A2aCaller } from "./a2a-task.ts";
import {
  currentTurnId,
  readTask,
  readTaskAfresh,
  TERMINAL_TASK_STATES,
  type TaskRow,
} from "./a2a-task-state.ts";
import { pushEndedA2aTasks } from "./a2a-push.ts";

/**
 * Cancelling A2A Tasks (ADR-0032). A cancel is recorded on its Task before
 * its run is stopped, so every reader sees `canceled` at once, and the record
 * outlives the cancel message: a run the message missed, while its instance's
 * listener was reconnecting, is found from it by that instance's sweep.
 *
 * A run is its Chat's, keyed by the Chat's id, so a cancel is narrowed to the
 * run of its Task's turn: never the Chat's next turn, nor a regenerate the
 * Owner started after it.
 */

/** How often each instance looks for canceled Tasks whose run it holds. */
const SWEEP_MS = 5_000;

/** Whether the Chat is still on `task`'s turn, so its run is the Task's. */
const isCurrentTurn = async (task: Pick<TaskRow, "chatId" | "messageId">) =>
  (await currentTurnId(task.chatId)) === task.messageId;

/**
 * `CancelTask`: one of this endpoint's Tasks, `canceled`, its run stopped on
 * whichever instance holds it. A Task that has already ended is answered as
 * it ended, and nothing is stopped.
 */
export const cancelA2aTask = async (
  caller: A2aCaller,
  taskId: string,
): Promise<Task> => {
  const task = await findA2aTask(caller, taskId);
  const read = await readTask(task);
  if (TERMINAL_TASK_STATES.has(read.status!.state)) return read;

  const canceledAt = new Date();
  // Claimed only while no end is recorded: a run that ended first keeps its
  // own end, and stops nothing.
  const [claimed] = await db
    .update(a2aTaskTable)
    .set({ state: "canceled", canceledAt })
    .where(and(eq(a2aTaskTable.id, task.id), isNull(a2aTaskTable.state)))
    .returning();
  if (!claimed) return readTaskAfresh(task);

  if (await isCurrentTurn(task)) {
    // A cancel that can't be sent is still recorded; the sweep stops the run.
    await cancelRun(task.chatId, { startedBefore: canceledAt }).catch(
      (error: unknown) =>
        logger.error({ error, taskId }, "Sending an A2A cancel failed"),
    );
  }
  void pushEndedA2aTasks(task.chatId);
  return readTask(claimed);
};

/**
 * Stops each run held here whose Task was canceled after the run started, and
 * is still that run's turn. Finds nothing while every cancel arrives.
 */
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
    if (!(await isCurrentTurn(task))) continue;
    runRegistry.cancel(task.chatId, {
      startedBefore: task.canceledAt!.getTime(),
    });
  }
};

/**
 * Sweeps for canceled Tasks' runs every few seconds, for as long as the
 * process runs.
 *
 * ponytail: a run's start and a cancel's moment come from different
 * instances' clocks. A regenerate of a canceled turn started within the skew
 * between them could be stopped too.
 */
export const watchForCanceledA2aRuns = (): void => {
  setInterval(() => {
    stopCanceledA2aRuns().catch((error: unknown) =>
      logger.error({ error }, "Sweeping canceled A2A runs failed"),
    );
  }, SWEEP_MS).unref();
};
