import { logger } from "../logger.ts";
import { runRegistry } from "./run-registry.ts";

// why: under docker stop's 10s grace, so the kill doesn't cut the drain short
export const SHUTDOWN_DRAIN_MS = 8_000;

export const CRASH_DRAIN_MS = 2_000;

export const drainRuns = async (
  timeoutMs: number = SHUTDOWN_DRAIN_MS,
): Promise<boolean> => {
  runRegistry.beginStop();
  for (const { runId } of runRegistry.heldRuns()) runRegistry.cancel(runId);
  return runRegistry.whenIdle(timeoutMs);
};

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

  options.stopBackground?.();
  options.stopAccepting?.();
  options.closeIdleConnections?.();

  let complete = await drainRuns(deadline - Date.now());
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

export const installShutdownHandlers = (options: {
  stopBackground?: () => void;
  stopAccepting?: () => void;
  closeIdleConnections?: () => void;
  close?: () => Promise<void>;
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
