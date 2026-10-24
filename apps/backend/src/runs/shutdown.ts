import type { Server } from "node:http";
import { logger } from "../logger.ts";
import { withDeadline } from "../utils/abort-race.ts";
import { errorMessage } from "../utils/error-message.ts";
import { runRegistry } from "./run-registry.ts";

/**
 * How long a stopping process waits for its work to finish: its runs to write
 * their ends, its connections to close, the database pool to end. Under the
 * 10 seconds `docker stop` gives before it kills, so the wait is not cut short
 * by the kill it exists to beat.
 */
export const SHUTDOWN_DRAIN_MS = 8_000;

/**
 * The same wait after a crash: shorter, since a process in an unknown state
 * should not linger, but long enough for its runs to write their ends.
 */
export const CRASH_DRAIN_MS = 3_000;

/** Kept back from the connections' wait for ending the database pool. */
const POOL_END_RESERVE_MS = 1_000;

/** Whether `promise` settles within `ms`, whichever way. */
const settlesWithin = (promise: Promise<unknown>, ms: number) =>
  withDeadline(() => promise, Math.max(ms, 0)).then(
    () => true,
    () => false,
  );

/**
 * Cancels every run this process holds and waits, at most `timeoutMs`, for
 * each to write its end (#1297). A Chat's run writes `cancelled` and leaves
 * `running`, so the Chat is free the moment the process is gone rather than
 * once its heartbeat goes stale. `true` when every run ended in time.
 */
export const drainRuns = async (
  timeoutMs: number = SHUTDOWN_DRAIN_MS,
): Promise<boolean> => {
  for (const { runId } of runRegistry.heldRuns()) runRegistry.cancel(runId);
  return runRegistry.whenIdle(timeoutMs);
};

/**
 * On SIGTERM or SIGINT, stop taking work, let the work in hand finish within
 * {@link SHUTDOWN_DRAIN_MS}, then exit: 0 when everything finished in time,
 * 1 when the drain ran out. In order:
 *
 * 1. Refuse new runs (`runRegistry.stopping`, a 503) and stop the background
 *    jobs, so no timer starts a run the exit would cut off.
 * 2. Close the connections with no request in flight, and stop listening.
 * 3. Cancel the runs held here and wait for each to write its end.
 * 4. Wait for the remaining connections to close; past the budget (less a
 *    second kept for step 5), cut them.
 * 5. End the database pool.
 *
 * An uncaught exception or unhandled rejection logs fatal and runs the same
 * drain within {@link CRASH_DRAIN_MS}, then exits 1: plugins run in-process,
 * and a stray rejection in one must not end runs without their ends written.
 *
 * A second signal while draining is ignored; the drain is already bounded.
 * Returns a function that removes the handlers.
 */
export const installShutdownHandlers = (options: {
  /** Stops the background jobs: the schedulers, listeners and sweeps. */
  stopBackground?: () => void;
  server?: Pick<
    Server,
    "close" | "closeIdleConnections" | "closeAllConnections"
  >;
  closePool?: () => Promise<void>;
  exit?: (code: number) => void;
  timeoutMs?: number;
  crashTimeoutMs?: number;
}): (() => void) => {
  const exit = options.exit ?? ((code: number) => process.exit(code));
  let stopping = false;
  let crashed = false;

  const shutdown = async (budgetMs: number): Promise<void> => {
    const deadline = Date.now() + budgetMs;
    const remaining = () => deadline - Date.now();

    runRegistry.stopping = true;
    options.stopBackground?.();

    const { server } = options;
    const serverClosed = new Promise<void>((resolve) => {
      if (!server) return resolve();
      server.closeIdleConnections();
      server.close(() => resolve());
    });

    let finished = await drainRuns(remaining());
    if (!finished) logger.warn("Shutting down with runs that did not end");

    // An A2A follower of a Task running on another instance holds its stream
    // until that Task ends, so it is the one cut here.
    const closeBudget = remaining() - POOL_END_RESERVE_MS;
    if (!(await settlesWithin(serverClosed, closeBudget))) {
      logger.warn("Shutting down with connections still open");
      server?.closeAllConnections();
      finished = false;
    }

    if (options.closePool) {
      const pool = options.closePool().catch((err: unknown) => {
        logger.error({ err }, "Closing the database pool failed");
      });
      if (!(await settlesWithin(pool, remaining()))) {
        logger.warn("Shutting down with database connections still in use");
        finished = false;
      }
    }

    exit(finished && !crashed ? 0 : 1);
  };

  const onSignal = (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    const held = runRegistry.heldRuns().length;
    logger.info({ signal, runs: held }, "Shutting down: ending held runs");
    void shutdown(options.timeoutMs ?? SHUTDOWN_DRAIN_MS);
  };

  const onCrash = (err: unknown) => {
    logger.fatal({ err }, `Crashed, shutting down: ${errorMessage(err)}`);
    crashed = true;
    // Already draining: that drain exits, now with 1.
    if (stopping) return;
    stopping = true;
    void shutdown(options.crashTimeoutMs ?? CRASH_DRAIN_MS);
  };

  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  process.on("uncaughtException", onCrash);
  process.on("unhandledRejection", onCrash);
  return () => {
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
    process.off("uncaughtException", onCrash);
    process.off("unhandledRejection", onCrash);
  };
};
