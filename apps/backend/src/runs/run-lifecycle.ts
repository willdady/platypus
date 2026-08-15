import { logger } from "../logger.ts";
import { rejectedToolInputs } from "../rejected-tool-input.ts";
import type { ToolActivityEvent } from "../services/tool-activity.ts";
import { isTruncatedByTokenLimit } from "./stream-error.ts";
import { accumulateStepStats, type RunStep } from "./run-stats.ts";
import {
  runRegistry,
  TimeoutError,
  type RunHandle,
  type RunTimeouts,
} from "./run-registry.ts";
import type { RunId, RunStats, RunStatus } from "./types.ts";

/**
 * A registered run: its abort signal and timers, its accumulating statistics,
 * the callbacks the SDK invokes, and a once-only termination.
 *
 * Every run in the system holds one of these — Chat turns and Trigger runs
 * through `AgentRunner`, delegated runs through the sub-agent tool. Nothing
 * else registers with `RunRegistry`, so nothing else can time out, be
 * cancelled, or go unobserved.
 */
export type RunLifecycle = {
  handle: RunHandle;
  /** Accumulated as steps finish; read by the terminal callback. */
  readonly stats: RunStats;
  /**
   * Replace the accumulated statistics with the authoritative per-run figures
   * an SDK result carries (`computeStats`). The accumulator exists so a run
   * that never reaches its result — cancelled, timed out — still reports
   * something; where a result does arrive, it wins.
   */
  setStats: (next: RunStats) => void;
  /** `onStepFinish` for `streamText` / `generateText`. */
  onStep: (step: RunStep) => void;
  /** Tool-call boundary handler for `wrapToolsWithActivity`. */
  onActivity: (event: ToolActivityEvent) => void;
  /** Terminate once, with the outcome. Repeat calls are no-ops. */
  finish: (status: RunStatus, error?: Error) => Promise<void>;
  /**
   * How this run ended, as far as its abort signal knows: `succeeded` while the
   * signal is clear, `cancelled` where someone stopped it, and `failed` with the
   * `TimeoutError` where a timer did. The one place that reading is made, so no
   * caller re-derives it from `signal.reason`.
   */
  statusFromSignal: () => { status: RunStatus; error?: Error };
  /**
   * Why the run was stopped, as a sentence, or `undefined` while it is still
   * running. A cancellation reaches `statusFromSignal` as a status with no
   * error — deliberately, since nothing failed — so a caller that has to *say*
   * what happened asks here instead of unpacking `signal.reason` itself.
   */
  abortReason: () => string | undefined;
};

/**
 * Registers a run and wires its timers, statistics and logging.
 *
 * The caller supplies `onTerminate`, which runs exactly once whichever way the
 * run ends — success, failure, cancellation, or a timeout that fires while the
 * model call is still in flight. Unregistering is handled here so no caller can
 * leak an entry.
 */
export const startRun = (params: {
  runId: RunId;
  /** Fields stamped on every log line this run emits (org, workspace, …). */
  log?: Record<string, unknown>;
  timeouts?: RunTimeouts;
  onTerminate: (ctx: {
    status: RunStatus;
    error?: Error;
    stats: RunStats;
  }) => Promise<void> | void;
  /** Called after each step is folded into `stats`. */
  onStepProgress?: (stats: RunStats) => void;
}): RunLifecycle => {
  const { runId, onTerminate } = params;
  const logFields = { runId, ...params.log };
  let stats: RunStats = {};
  let terminated = false;

  const finish = async (status: RunStatus, error?: Error): Promise<void> => {
    if (terminated) return;
    terminated = true;
    try {
      await onTerminate({ status, error, stats });
    } catch (err) {
      logger.error({ err, ...logFields }, "Error terminating run");
    }
    runRegistry.unregister(runId);
  };

  const handle = runRegistry.register(runId, {
    ...params.timeouts,
    onTimeout: (error) => {
      logger.error(
        { ...logFields, kind: error.kind, message: error.message, stats },
        "Run timed out",
      );
      void finish("failed", error);
    },
  });

  const onStep = (step: RunStep): void => {
    handle.bumpStep();
    accumulateStepStats(stats, step);
    logger.info(
      {
        ...logFields,
        step: stats.steps,
        toolCalls: step.toolCalls?.map((tc) => tc.toolName) ?? [],
        finishReason: step.finishReason,
        rawFinishReason: step.rawFinishReason,
        stats,
      },
      "Step finished",
    );
    if (isTruncatedByTokenLimit(step.finishReason)) {
      logger.warn(
        {
          ...logFields,
          step: stats.steps,
          rawFinishReason: step.rawFinishReason,
        },
        "Step truncated at the output token limit",
      );
    }
    // What the model actually emitted for a tool call that failed. At `debug`
    // because tool arguments are model and user data: at the default
    // `LOG_LEVEL=info` nothing is written, and an Operator diagnosing a
    // recurrence raises the level (issue #421).
    for (const rejected of rejectedToolInputs(step.content)) {
      logger.debug(
        { ...logFields, step: stats.steps, ...rejected },
        "Tool call failed",
      );
    }
    params.onStepProgress?.(stats);
  };

  // Start events hold the per-step stall timer down for the duration of the
  // call; end events release it and log the measured duration, so a post-mortem
  // of a stalled run shows exactly which tool was slow.
  const onActivity = (event: ToolActivityEvent): void => {
    if (event.phase === "start") {
      handle.holdStep();
      logger.debug(
        { ...logFields, toolName: event.toolName },
        "Tool call started",
      );
      return;
    }
    handle.releaseStep();
    logger.info(
      { ...logFields, toolName: event.toolName, durationMs: event.durationMs },
      "Tool call finished",
    );
  };

  const statusFromSignal = (): { status: RunStatus; error?: Error } => {
    if (!handle.signal.aborted) return { status: "succeeded" };
    const reason: unknown = handle.signal.reason;
    return reason instanceof TimeoutError
      ? { status: "failed", error: reason }
      : { status: "cancelled" };
  };

  const abortReason = (): string | undefined => {
    if (!handle.signal.aborted) return undefined;
    const reason: unknown = handle.signal.reason;
    return reason instanceof Error ? reason.message : undefined;
  };

  return {
    handle,
    get stats() {
      return stats;
    },
    setStats: (next: RunStats) => {
      stats = next;
    },
    onStep,
    onActivity,
    finish,
    statusFromSignal,
    abortReason,
  };
};
