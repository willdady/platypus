import { stepCountIs, type LanguageModel, type Tool } from "ai";
import { logger } from "../logger.ts";
import { rejectedToolInputs } from "../rejected-tool-input.ts";
import type { ToolActivityEvent } from "../services/tool-activity.ts";
import { isTruncatedByTokenLimit } from "./stream-error.ts";
import type { NoProgressDetector } from "./no-progress.ts";
import {
  runRegistry,
  TimeoutError,
  type RegisterOptions,
  type RunHandle,
} from "./run-registry.ts";
import type { RunId, RunStats, RunStatus } from "./types.ts";

/**
 * The generation half of a resolved turn: everything the model call needs
 * except the conversation itself.
 *
 * Structurally what `ChatTurn["stream"]` carries, minus `messages` — a Chat
 * turn passes UI messages that still need converting, a delegated run passes a
 * single task prompt, and neither of those belongs in the shared assembly.
 */
export type RunPlan = {
  model: LanguageModel;
  tools: Record<string, Tool>;
  system?: string;
  maxSteps: number;
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  seed?: number;
};

/**
 * Assembles the model/tools/system/stopWhen/ceiling/sampling arguments shared
 * by every run, whichever entry point drives it.
 *
 * Generation params pass through as-is (including `undefined`): the SDK treats
 * an absent key and an `undefined` value identically, and the streaming path
 * has always passed them this way in production.
 */
export const buildModelInvocation = (
  plan: RunPlan,
  options: {
    abortSignal: AbortSignal;
    /**
     * Stop conditions beyond the step ceiling — currently the no-progress
     * detector on unattended runs.
     */
    extraStopConditions?: NoProgressDetector["stopCondition"][];
  },
) => ({
  model: plan.model,
  system: plan.system,
  tools: plan.tools,
  stopWhen: [
    stepCountIs(plan.maxSteps),
    ...(options.extraStopConditions ?? []),
  ],
  abortSignal: options.abortSignal,
  // The Provider's declared ceiling for this model, or undefined when it
  // declares none — which is what Bedrock needs, since its Converse request
  // carries no `inferenceConfig.maxTokens` at all unless one is passed
  // (issue #454).
  maxOutputTokens: plan.maxOutputTokens,
  temperature: plan.temperature,
  topP: plan.topP,
  topK: plan.topK,
  frequencyPenalty: plan.frequencyPenalty,
  presencePenalty: plan.presencePenalty,
  seed: plan.seed,
});

/**
 * One step's Context occupancy: the input tokens the vendor reported for it,
 * which is the whole conversation as that call sent it (ADR-0018). `undefined`
 * where the step reported none — nothing is estimated, and 0 would read as a
 * measurement of an empty context.
 */
export const stepOccupancy = (usage?: {
  inputTokens?: number;
}): number | undefined =>
  typeof usage?.inputTokens === "number" ? usage.inputTokens : undefined;

/** As much of an SDK step result as the run lifecycle reads. */
export type RunStep = {
  toolCalls?: Array<{ toolName: string }>;
  usage?: { inputTokens?: number; outputTokens?: number };
  // Both reasons, deliberately. The unified union collapses any reason the
  // provider adapter doesn't recognise into `other` — which is how Bedrock's
  // `malformed_tool_use` becomes indistinguishable from a dozen other endings.
  // The raw value is the only record of what the provider actually said
  // (issue #406).
  finishReason?: string;
  rawFinishReason?: string;
  /**
   * The step's parts, read only for the tool calls that failed. Both the
   * streaming and the unattended path record a `tool-error` here, so one
   * callback covers both — `onChunk` would cover only streaming.
   */
  content?: unknown;
};

/**
 * Folds a single step's tool calls and usage into a running `RunStats`
 * accumulator. Mutates `stats` in place, so a consumer can observe partial
 * progress without waiting for the final result.
 */
export const accumulateStepStats = (stats: RunStats, step: RunStep): void => {
  stats.steps = (stats.steps ?? 0) + 1;
  const counts = new Map<string, number>(
    (stats.toolCalls ?? []).map((tc) => [tc.name, tc.count]),
  );
  for (const tc of step.toolCalls ?? []) {
    counts.set(tc.toolName, (counts.get(tc.toolName) ?? 0) + 1);
  }
  stats.toolCalls = Array.from(counts, ([name, count]) => ({ name, count }));
  if (step.usage) {
    stats.inputTokens =
      (stats.inputTokens ?? 0) + (step.usage.inputTokens ?? 0);
    stats.outputTokens =
      (stats.outputTokens ?? 0) + (step.usage.outputTokens ?? 0);
  }
  // REPLACED, not summed, and outside the guard above: the whole conversation
  // is in every step's input count, so the latest step is the current context
  // size while the running totals are sums of context sizes (ADR-0018). A step
  // that reports nothing — no count, or no usage object at all — clears the
  // figure rather than leaving an earlier, smaller step's standing as if it
  // were current, which is what a mid-run stats flush would otherwise publish.
  stats.contextOccupancy = stepOccupancy(step.usage);
};

/**
 * Computes per-run statistics from an AI SDK result with `steps` and
 * `totalUsage`. Works for both stream and generate paths.
 */
export const computeStats = (result: {
  steps: Array<{
    toolCalls: Array<{ toolName: string }>;
    usage?: { inputTokens?: number };
  }>;
  totalUsage: { inputTokens?: number; outputTokens?: number };
}): RunStats => {
  const toolCallCounts = new Map<string, number>();
  for (const step of result.steps) {
    for (const tc of step.toolCalls) {
      toolCallCounts.set(
        tc.toolName,
        (toolCallCounts.get(tc.toolName) ?? 0) + 1,
      );
    }
  }
  // The FINAL step only. Scanning back for the most recent step that did report
  // a count would answer with a smaller, earlier context as though it were the
  // one the run ended on.
  const contextOccupancy = stepOccupancy(result.steps.at(-1)?.usage);
  return {
    steps: result.steps.length,
    toolCalls: Array.from(toolCallCounts, ([name, count]) => ({ name, count })),
    inputTokens: result.totalUsage.inputTokens ?? 0,
    outputTokens: result.totalUsage.outputTokens ?? 0,
    // Spread so a run whose Provider reported no usage stores no key at all,
    // matching the schema's optional field: absent means unknown, and 0 would
    // read as a measurement of an empty context.
    ...(contextOccupancy === undefined ? {} : { contextOccupancy }),
  };
};

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
   * The status an otherwise-successful ending should be recorded under: a run
   * whose signal was aborted ended because someone stopped it, and a timeout
   * is a failure rather than a cancellation.
   */
  statusFromSignal: () => { status: RunStatus; error?: Error };
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
  timeouts?: Pick<RegisterOptions, "perStepTimeoutMs" | "perRunTimeoutMs">;
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
  };
};
