import { logger } from "../logger.ts";
import { runRegistry } from "./run-registry.ts";

/**
 * How long a stopping process waits for its runs to write their ends. Under
 * the 10 seconds `docker stop` gives before it kills, so the wait is not cut
 * short by the kill it exists to beat.
 */
export const SHUTDOWN_DRAIN_MS = 8_000;

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
 * On SIGTERM or SIGINT: stop taking requests, drain the runs held here, then
 * exit. A second signal while draining is ignored; the drain is already bounded.
 * Returns a function that removes the handlers.
 */
export const installShutdownHandlers = (options: {
  /** Stops new requests (and so new runs) reaching this process. */
  stopAccepting?: () => void;
  exit?: (code: number) => void;
  timeoutMs?: number;
}): (() => void) => {
  const exit = options.exit ?? ((code: number) => process.exit(code));
  let stopping = false;
  const onSignal = (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    const held = runRegistry.heldRuns().length;
    logger.info({ signal, runs: held }, "Shutting down: ending held runs");
    options.stopAccepting?.();
    void drainRuns(options.timeoutMs).then((drained) => {
      if (!drained) {
        logger.warn("Shutting down with runs that did not end in time");
      }
      exit(0);
    });
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  return () => {
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
  };
};
