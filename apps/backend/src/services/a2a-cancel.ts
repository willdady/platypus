import { and, eq, gt, inArray, isNotNull, isNull } from "drizzle-orm";
import type { Task } from "@a2a-js/sdk";
import { TaskNotCancelableError } from "@a2a-js/sdk/errors";
import { db } from "../index.ts";
import { a2aTask as a2aTaskTable, chat as chatTable } from "../db/schema.ts";
import { logger } from "../logger.ts";
import { cancelRun } from "../runs/run-cancel.ts";
import { runRegistry } from "../runs/run-registry.ts";
import { findA2aTask, type A2aCaller } from "./a2a-task.ts";
import {
  currentTurnId,
  readTask,
  isTerminal,
  type TaskRow,
} from "./a2a-task-state.ts";
import { pushEndedA2aTasks } from "./a2a-push.ts";
import { taskIsLive } from "./a2a-liveness.ts";

/**
 * Cancelling A2A Tasks (ADR-0032). A cancel is recorded on its Task before
 * its run is stopped, so every reader sees `canceled` at once, and the record
 * outlives the cancel message: a run the message missed, while its instance's
 * listener was reconnecting, is found from it by that instance's sweep.
 *
 * A run is its Chat's, keyed by the Chat's id, so a cancel is narrowed to the
 * run of its Task's turn: never the Chat's next turn, nor a regenerate the
 * Owner started after it.
 *
 * Cutting off a client's access cancels its running Tasks the same way: at
 * once for what an Org Admin or the Owner changes here, and at the next sweep
 * for what happens elsewhere — the Owner leaving the Organization or being
 * banned, or an endpoint deleted with its Agent.
 */

/** How often each instance looks for canceled Tasks whose run it holds. */
const SWEEP_MS = 5_000;

/** Whether the Chat is still on `task`'s turn, so its run is the Task's. */
const isCurrentTurn = async (task: Pick<TaskRow, "chatId" | "messageId">) =>
  (await currentTurnId(task.chatId)) === task.messageId;

/**
 * `CancelTask`: one of this endpoint's Tasks, `canceled`, its run stopped on
 * whichever instance holds it. A Task whose run has already ended, though
 * its end was written a moment ago, is refused as not cancelable, keeps that
 * end, and nothing is stopped.
 */
export const cancelA2aTask = async (
  caller: A2aCaller,
  taskId: string,
): Promise<Task> => {
  const claimed = await cancelTask(await findA2aTask(caller, taskId));
  if (!claimed) throw new TaskNotCancelableError();
  return readTask(claimed);
};

/**
 * Records `task` canceled and stops its run, on whichever instance holds it.
 * `undefined`, stopping nothing, when the Task has already ended.
 */
const cancelTask = async (task: TaskRow): Promise<TaskRow | undefined> => {
  const read = await readTask(task);
  if (isTerminal(read)) return undefined;

  const canceledAt = new Date();
  const claimed = await db.transaction(async (tx) => {
    // Claimed only while the Task's turn is still running: its Chat
    // `running`, on its turn, and no end recorded. The Chat's row is locked
    // first, so a run's terminal write, which records its Task's end in the
    // same transaction, lands wholly before the claim or wholly after it
    // (#1309): a run that ended first keeps its own end, and stops nothing.
    const [chat] = await tx
      .select({ status: chatTable.status })
      .from(chatTable)
      .where(eq(chatTable.id, task.chatId))
      .for("update");
    if (chat?.status !== "running") return undefined;
    if ((await currentTurnId(task.chatId, tx)) !== task.messageId) {
      return undefined;
    }
    const [row] = await tx
      .update(a2aTaskTable)
      .set({ state: "canceled", canceledAt, statusAt: canceledAt })
      .where(and(eq(a2aTaskTable.id, task.id), isNull(a2aTaskTable.state)))
      .returning();
    return row;
  });
  if (!claimed) return undefined;

  // A cancel that can't be sent is still recorded; the sweep stops the run.
  await cancelRun(task.chatId, { startedBefore: canceledAt }).catch(
    (error: unknown) =>
      logger.error({ error, taskId: task.id }, "Sending an A2A cancel failed"),
  );
  void pushEndedA2aTasks(task.chatId);
  return claimed;
};

/** Cancels each of `tasks` whose token or endpoint is no longer live. */
const cancelRevoked = async (tasks: TaskRow[]): Promise<void> => {
  for (const task of tasks) {
    if (!(await taskIsLive(task))) await cancelTask(task);
  }
};

/**
 * Cancels the running Tasks of Chats started on `endpointIds` whose token or
 * endpoint is no longer live, after access to them was cut off: a token
 * deleted or regenerated, an endpoint disabled, deleted or revoked, or the
 * Org gate narrowed. Every other Task on them runs on. Found by Chat, whose
 * endpoint id outlives the endpoint. Never throws: the cut-off has happened,
 * and the sweep cancels anything missed here.
 */
export const stopRevokedA2aWork = async (
  endpointIds: string[],
): Promise<void> => {
  if (endpointIds.length === 0) return;
  try {
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

/**
 * Cancels each run held here whose Task's token or endpoint is no longer
 * live. Catches what no change here announces: the Owner leaving the
 * Organization or being banned, an endpoint deleted with its Agent, or a
 * Task started just as its access was cut off.
 */
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
 * Sweeps for canceled Tasks' runs, and revoked clients' runs, every few
 * seconds, for as long as the process runs.
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
    stopRevokedA2aRuns().catch((error: unknown) =>
      logger.error({ error }, "Sweeping revoked A2A runs failed"),
    );
  }, SWEEP_MS).unref();
};
