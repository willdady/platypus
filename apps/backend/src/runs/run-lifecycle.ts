import { logger } from "../logger.ts";
import { rejectedToolInputs } from "../rejected-tool-input.ts";
import type { ToolActivityEvent } from "../services/tool-activity.ts";
import { isTruncatedByTokenLimit } from "./stream-error.ts";
import type { ModelUsage } from "@platypus/schemas";
import {
  accumulateStepStats,
  mergeUsageByModel,
  withDelegatedUsage,
  type RunStep,
  type UsageModel,
} from "./run-stats.ts";
import {
  runRegistry,
  TimeoutError,
  type RunHandle,
  type RunTimeouts,
} from "./run-registry.ts";
import type { RunId, RunStats, RunStatus } from "./types.ts";

/**
 * How long an aborted run waits for its drive to settle before it is finished
 * anyway (#1613). Long enough for a drive that observes its signal to unwind
 * and write its own final state; short enough that work which never unwinds
 * still reaches a terminal status promptly (#937).
 */
export const ABORT_GRACE_MS = 5_000;

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
  /**
   * The run's OWN model calls, accumulated as steps finish. What the terminal
   * callback is handed also counts its delegates — see `withDelegatedUsage`.
   */
  readonly stats: RunStats;
  /** The (Provider, model) pair the run's own calls are billed under, so they
   *  are one row of `usageByModel`. Set by the drive, from its plan. */
  setUsageModel: (model: UsageModel | undefined) => void;
  /** Records a delegated run's latest stats, folded into this run's (issue
   *  #1634). Each call replaces that delegate's previous report. */
  setDelegateUsage: (delegateRunId: RunId, stats: RunStats) => void;
  /** The delegates' usage folded so far, by (Provider, model). */
  delegatedUsage: () => readonly ModelUsage[];
  /**
   * Replace the accumulated statistics with the authoritative per-run figures
   * an SDK result carries (`computeStats`). The accumulator exists so a run
   * that never reaches its result — cancelled, timed out — still reports
   * something; where a result does arrive, it wins.
   */
  setStats: (next: RunStats) => void;
  /** `onStepFinish` for `streamText` / `generateText`. */
  onStep: (step: RunStep) => void;
  /**
   * `onChunk` for `streamText`. Tells the idle timer the provider is still
   * talking, so a step that streams for longer than the per-step bound is not
   * mistaken for a stall (issue #552). Nothing is logged or accumulated here:
   * it runs once per streamed chunk.
   */
  onStreamChunk: () => void;
  /** Tool-call boundary handler for `wrapToolsWithActivity`. */
  onActivity: (event: ToolActivityEvent) => void;
  /** Terminate once, with the outcome. Repeat calls are no-ops. */
  finish: (status: RunStatus, error?: Error) => Promise<void>;
  /**
   * Hand the run a Tool session's `dispose` to close when it ends — or, if the
   * run has already ended or been stopped, have it closed here (finishing the
   * run, if it is not finished yet) and be told so. `false` means
   * the second: `dispose` has been run, and the caller must not go on.
   *
   * Both halves are the method, which is why the name carries them. A run's
   * timers are armed the moment it registers, and that is *before* Turn
   * resolution is awaited — so a resolution slower than the per-step bound
   * reaches a run whose teardown has already been and gone. A caller that
   * simply stored the disposer would have stored it where nothing will ever
   * read it again (issue #630), and a caller that checked first would be
   * checking across an await. Nothing here awaits between the check and the
   * store, so no termination can land in the middle of one.
   *
   * The invariant this exists to make true by construction: **a disposer is
   * only ever held by a run that can still run it.**
   */
  adoptOrDispose: (dispose: () => Promise<void>) => Promise<boolean>;
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
  let usageModel: UsageModel | undefined;
  let delegated: ModelUsage[] = [];
  const delegateReports = new Map<RunId, readonly ModelUsage[]>();
  const reported = (): RunStats =>
    withDelegatedUsage(stats, usageModel, delegated);
  let terminated = false;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  /** The Tool session this run must close, once it has one — see
   *  {@link RunLifecycle.adoptOrDispose}. One, not a list: a run resolves one
   *  turn, and a turn has exactly one session to dispose however many tool
   *  sources it reached (`GLOSSARY.md`, **Tool session**). */
  let disposer: (() => Promise<void>) | undefined;

  /** Run the disposer without letting it break the path it is on — the guard
   *  `AgentRunner`'s terminal callback used to hold, moved here with the
   *  disposal it protects. A teardown that throws must not stop the run being
   *  finished, nor a failure from reaching the caller. */
  const runDisposer = async (dispose: () => Promise<void>): Promise<void> => {
    try {
      await dispose();
    } catch (err) {
      logger.error({ err, ...logFields }, "Error disposing turn");
    }
  };

  const finish = async (status: RunStatus, error?: Error): Promise<void> => {
    if (terminated) return;
    terminated = true;
    clearTimeout(graceTimer);
    // Before `onTerminate`, so the connections a turn opened are closed by the
    // time the sink writes the run's terminal record.
    if (disposer) await runDisposer(disposer);
    try {
      await onTerminate({ status, error, stats: reported() });
    } catch (err) {
      logger.error({ err, ...logFields }, "Error terminating run");
    }
    runRegistry.unregister(runId);
  };

  const adoptOrDispose = async (
    dispose: () => Promise<void>,
  ): Promise<boolean> => {
    // Stopped before a drive could take it: no drive will unwind to finish
    // the run, so nothing is gained by waiting out the abort grace.
    if (!terminated && handle.signal.aborted) {
      disposer = dispose;
      await finishFromSignal();
      return false;
    }
    if (terminated) {
      await runDisposer(dispose);
      return false;
    }
    disposer = dispose;
    return true;
  };

  const handle = runRegistry.register(runId, {
    ...params.timeouts,
    // Logging only. The registry aborts the controller before calling this,
    // and the abort listener below is what terminates the run.
    onTimeout: (error) => {
      logger.error(
        {
          ...logFields,
          kind: error.kind,
          message: error.message,
          stats: reported(),
        },
        "Run timed out",
      );
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
    params.onStepProgress?.(reported());
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

  /** Finish with the outcome the abort signal records. */
  const finishFromSignal = (): Promise<void> => {
    const { status, error } = statusFromSignal();
    return finish(status, error);
  };

  const abortReason = (): string | undefined => {
    if (!handle.signal.aborted) return undefined;
    const reason: unknown = handle.signal.reason;
    return reason instanceof Error ? reason.message : undefined;
  };

  /**
   * An abort finishes the run itself if the run's own work does not first.
   *
   * Both ways a run is stopped — `RunRegistry.cancel` and either timeout —
   * abort the controller and clear the run's timers. Once, the terminal write
   * depended entirely on the run's own work unwinding afterwards: every
   * in-flight tool promise settling, the drive draining, its `finally` calling
   * `finish`. Anything that does not observe the signal never unwinds, and with
   * both timers already cleared nothing was left to recover it — the Chat row
   * kept `status: "running"` and the registry entry was never unregistered, so
   * every later turn in that Chat was answered 409 until the process restarted
   * (#937). This is the one place every run in the system registers, so it is
   * where the guarantee belongs: an aborted run reaches a terminal status
   * whatever its work is doing.
   *
   * It does so after {@link ABORT_GRACE_MS}, not at once (#1613). A drive that
   * unwinds within the grace finishes with its full final state — tool
   * durations, normalised web-tool parts, the SDK's stats — which an immediate
   * finish would have discarded. And the registry claim is held until then, so
   * a new turn on the same Chat cannot start while a tool from the stopped one
   * is still running against the same resources. `finish` is once-only and
   * clears the timer, so whoever gets there first wins.
   */
  handle.signal.addEventListener(
    "abort",
    () => {
      // A stopping process has no next turn to hold the claim against, and a
      // crash drain is shorter than the grace: finish now, as before #1613.
      if (runRegistry.stopping) {
        void finishFromSignal();
        return;
      }
      graceTimer = setTimeout(() => void finishFromSignal(), ABORT_GRACE_MS);
    },
    { once: true },
  );

  return {
    handle,
    get stats() {
      return stats;
    },
    setStats: (next: RunStats) => {
      stats = next;
    },
    setUsageModel: (model) => {
      usageModel = model;
    },
    setDelegateUsage: (delegateRunId, delegate) => {
      delegateReports.set(delegateRunId, delegate.usageByModel ?? []);
      delegated = mergeUsageByModel([...delegateReports.values()].flat());
    },
    delegatedUsage: () => delegated,
    onStep,
    onStreamChunk: () => handle.noteActivity(),
    onActivity,
    finish,
    adoptOrDispose,
    statusFromSignal,
    abortReason,
  };
};
