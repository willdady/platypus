import { logger } from "../logger.ts";
import { rejectedToolInputs } from "../rejected-tool-input.ts";
import type { ToolActivityEvent } from "../services/tool-activity.ts";
import { isTruncatedByTokenLimit } from "./stream-error.ts";
import type { ModelUsage } from "@platypus/schemas";
import {
  accumulateStepStats,
  mergeUsageByModel,
  pickCachedInput,
  withDelegatedUsage,
  type RunStep,
  type UsageModel,
} from "./run-stats.ts";
import {
  runRegistry,
  TimeoutError,
  type RunHandle,
  type RunRegistry,
  type RunTimeouts,
} from "./run-registry.ts";
import type { RunId, RunStats, RunStatus } from "./types.ts";

export const ABORT_GRACE_MS = 5_000;

export type RunLifecycle = {
  handle: RunHandle;
  readonly stats: RunStats;
  setUsageModel: (model: UsageModel) => void;
  setDelegateUsage: (delegateRunId: RunId, stats: RunStats) => void;
  delegatedUsage: () => readonly ModelUsage[];
  setStats: (next: RunStats) => void;
  onStep: (step: RunStep) => void;
  onStreamChunk: () => void;
  onActivity: (event: ToolActivityEvent) => void;
  finish: (status: RunStatus, error?: Error) => Promise<void>;
  adoptOrDispose: (dispose: () => Promise<void>) => Promise<boolean>;
  statusFromSignal: () => { status: RunStatus; error?: Error };
  abortReason: () => string | undefined;
};

export const startRun = (params: {
  runId: RunId;
  log?: Record<string, unknown>;
  timeouts?: RunTimeouts;
  registry?: RunRegistry;
  onTerminate: (ctx: {
    status: RunStatus;
    error?: Error;
    stats: RunStats;
  }) => Promise<void> | void;
  onStepProgress?: (stats: RunStats) => void;
}): RunLifecycle => {
  const { runId, onTerminate } = params;
  const registry = params.registry ?? runRegistry;
  const logFields = { runId, ...params.log };
  let stats: RunStats = {};
  // why: a run can terminate before its model loop starts, so none is known yet
  let usageModel: UsageModel | undefined;
  let ownUsage: ModelUsage[] = [];
  let delegated: ModelUsage[] = [];
  const delegateReports = new Map<RunId, readonly ModelUsage[]>();
  const reported = (): RunStats =>
    withDelegatedUsage(stats, usageModel, delegated, ownUsage);
  let terminated = false;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  let disposer: (() => Promise<void>) | undefined;

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
    if (disposer) await runDisposer(disposer);
    try {
      await onTerminate({ status, error, stats: reported() });
    } catch (err) {
      logger.error({ err, ...logFields }, "Error terminating run");
    }
    registry.unregister(runId);
  };

  const adoptOrDispose = async (
    dispose: () => Promise<void>,
  ): Promise<boolean> => {
    // why: no await between these checks and the store, or a teardown lands between them
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

  const handle = registry.register(runId, {
    ...params.timeouts,
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
    if (usageModel && step.usage) {
      ownUsage = [
        ...ownUsage,
        {
          ...usageModel,
          inputTokens: step.usage.inputTokens ?? 0,
          outputTokens: step.usage.outputTokens ?? 0,
          ...pickCachedInput(step.usage.inputTokenDetails),
        },
      ];
    }
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
    for (const rejected of rejectedToolInputs(step.content)) {
      logger.debug(
        { ...logFields, step: stats.steps, ...rejected },
        "Tool call failed",
      );
    }
    params.onStepProgress?.(reported());
  };

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

  const finishFromSignal = (): Promise<void> => {
    const { status, error } = statusFromSignal();
    return finish(status, error);
  };

  const abortReason = (): string | undefined => {
    if (!handle.signal.aborted) return undefined;
    const reason: unknown = handle.signal.reason;
    return reason instanceof Error ? reason.message : undefined;
  };

  handle.signal.addEventListener(
    "abort",
    () => {
      if (registry.stopping) {
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
