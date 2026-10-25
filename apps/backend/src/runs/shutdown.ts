import { logger } from "../logger.ts";
import { runRegistry } from "./run-registry.ts";

/**
 * How long a stopping process waits for its runs to write their ends. Under
 * the 10 seconds `docker stop` gives before it kills, so the wait is not cut
 * short by the kill it exists to beat.
 */
export const SHUTDOWN_DRAIN_MS = 8_000;

/**
 * How long a crashing process waits for its runs to write their ends. A crash
 * is a bug: the budget is short so the death — and the log line that says why
 * — reach the orchestrator quickly, and the runs are only cancelled, never
 * awaited to stream anything more.
 */
export const CRASH_DRAIN_MS = 2_000;

/**
 * Cancels every run this process holds and waits, at most `timeoutMs`, for
 * each to write its end (#1297). A Chat's run writes `cancelled` and leaves
 * `running`, so the Chat is free the moment the process is gone rather than
 * once its heartbeat goes stale. `true` when every run ended in time.
 */
export const drainRuns = async (
  timeoutMs: number = SHUTDOWN_DRAIN_MS,
): Promise<boolean> => {
  // Stopping, so each cancelled run finishes at once rather than after the
  // abort grace (`run-lifecycle.ts`).
  runRegistry.beginStop();
  for (const { runId } of runRegistry.heldRuns()) runRegistry.cancel(runId);
  return runRegistry.whenIdle(timeoutMs);
};

/**
 * Awaits `fn`, but only while `timeoutMs` remains of the drain budget; once
 * the budget is gone it gives up. `true` when `fn` finished within the budget,
 * `false` when it did not get to finish (or never got to run).
 */
const withinBudget = (
  timeoutMs: number,
  fn: () => Promise<void>,
): Promise<boolean> => {
  if (timeoutMs <= 0) return Promise.resolve(false);
  return Promise.race<boolean>([
    fn().then(() => true),
    new Promise<boolean>((resolve) =>
      setTimeout(() => resolve(false), timeoutMs),
    ),
  ]);
};

/**
 * The ordered shutdown of one process, and what the drain accepts, all bounded
 * by `timeoutMs` from the moment it starts.
 *
 * Once the drain starts, the registry's stopping gate rejects every new run
 * (an HTTP caller is answered 503), so nothing the signal could not have seen
 * is started. The background schedulers are stopped first — a cron tick racing
 * the drain is refused by that gate rather than started and then killed by the
 * exit — then the HTTP listener closes, idle keep-alive and SSE connections
 * are dropped so `close()` is not held by them, the held runs are cancelled
 * and awaited to write their ends, the HTTP server's remaining in-flight
 * requests are awaited, and the Postgres pool is ended last, when nothing that
 * needs the database is still going.
 *
 * `true` when every step finished within the budget.
 */
export const drainProcess = async (
  options: {
    stopBackground?: () => void;
    stopAccepting?: () => void;
    closeIdleConnections?: () => void;
    close?: () => Promise<void>;
    endPool?: () => Promise<void>;
  },
  timeoutMs: number = SHUTDOWN_DRAIN_MS,
): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  runRegistry.beginStop();

  // No new work of any kind: the registry gate is already closed above.
  options.stopBackground?.();
  // The HTTP listener, then the connections only keeping it alive.
  options.stopAccepting?.();
  options.closeIdleConnections?.();

  // The runs held at this moment, so the ones the signal saw are the ones
  // that write their ends; a run the drain never saw could not have started.
  let complete = await drainRuns(deadline - Date.now());
  // The registry's own timeout is the budget's first claim; close and the pool
  // share whatever is left, in that order.
  if (options.close) {
    complete =
      (await withinBudget(deadline - Date.now(), options.close)) && complete;
  }
  if (options.endPool) {
    complete =
      (await withinBudget(deadline - Date.now(), options.endPool)) && complete;
  }
  return complete;
};

/**
 * On SIGTERM or SIGINT: stop new work of every kind, drain the runs held
 * here, close the HTTP server and the Postgres pool, then exit — with code 0
 * only when the whole drain finished within its budget. A second signal while
 * draining is ignored; the drain is already bounded.
 * Returns a function that removes the handlers.
 */
export const installShutdownHandlers = (options: {
  stopBackground?: () => void;
  /** Stops the HTTP listener taking new requests. */
  stopAccepting?: () => void;
  /** Drops idle keep-alive / SSE connections so the close below is not held. */
  closeIdleConnections?: () => void;
  /** Await closing the HTTP server once its in-flight requests have ended. */
  close?: () => Promise<void>;
  /** End the Postgres pool once nothing needs it. */
  endPool?: () => Promise<void>;
  exit?: (code: number) => void;
  timeoutMs?: number;
}): (() => void) => {
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const timeoutMs = options.timeoutMs ?? SHUTDOWN_DRAIN_MS;
  let stopping = false;
  const onSignal = (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    const held = runRegistry.heldRuns().length;
    logger.info(
      { signal, runs: held },
      "Shutting down: stopping new work and draining held runs",
    );
    void drainProcess(options, timeoutMs).then((complete) => {
      if (!complete) {
        logger.warn("Shutdown drain did not finish in time; exiting non-zero");
      }
      exit(complete ? 0 : 1);
    });
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  return () => {
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
  };
};

/**
 * On `unhandledRejection` or `uncaughtException`: the failing work is a plugin
 * timer or a stray promise, which Node would otherwise report through its
 * stderr path and die without draining. Log the crash fatal through pino,
 * cancel the runs held here so their Chats free at once, and exit 1 after a
 * short drain. A second crash while the first drains is ignored — the first
 * already decided the exit.
 * Returns a function that removes the handlers.
 */
export const installCrashHandlers = (
  options: {
    exit?: (code: number) => void;
    timeoutMs?: number;
  } = {},
): (() => void) => {
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const timeoutMs = options.timeoutMs ?? CRASH_DRAIN_MS;
  let crashing = false;
  const onCrash =
    (kind: "unhandledRejection" | "uncaughtException") => (reason: unknown) => {
      if (crashing) return;
      crashing = true;
      const error =
        reason instanceof Error ? reason : new Error(String(reason));
      logger.fatal({ err: error }, `Fatal: ${kind}`);
      // The same stopping gate as a signal's drain: nothing new may start on a
      // dying process, and the held runs get their short chance to write ends.
      runRegistry.beginStop();
      for (const { runId } of runRegistry.heldRuns()) runRegistry.cancel(runId);
      void runRegistry.whenIdle(timeoutMs).finally(() => exit(1));
    };
  const onRejection = onCrash("unhandledRejection");
  const onException = onCrash("uncaughtException");
  process.on("unhandledRejection", onRejection);
  process.on("uncaughtException", onException);
  return () => {
    process.off("unhandledRejection", onRejection);
    process.off("uncaughtException", onException);
  };
};
