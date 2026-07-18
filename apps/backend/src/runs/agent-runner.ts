import {
  APICallError,
  LoadAPIKeyError,
  convertToModelMessages,
  createIdGenerator,
  createUIMessageStreamResponse,
  generateText,
  readUIMessageStream,
  stepCountIs,
  streamText,
} from "ai";
import {
  prepareChatTurn,
  validateTurnAttachments,
  type ChatTurn,
  type ToolActivityEvent,
} from "../services/chat-execution.ts";
import { logger } from "../logger.ts";
import { actorUserId, type WorkspaceScope } from "../scope.ts";
import type { PlatypusUIMessage } from "../types.ts";
import {
  runRegistry,
  TimeoutError,
  type RegisterOptions,
  type RunHandle,
} from "./run-registry.ts";
import {
  createNoProgressDetector,
  NoProgressError,
  type NoProgressDetector,
} from "./no-progress.ts";
import type {
  ResolvedRunPlan,
  RunId,
  RunInput,
  RunSink,
  RunStats,
  RunStatus,
} from "./types.ts";

export type StreamOptions = {
  origin: string;
  frontendUrl?: string;
  /**
   * Override per-step / per-run timeouts for this run. The HTTP request
   * abort signal is intentionally NOT accepted — Chat runs continue to
   * completion regardless of the client connection (see issue #113).
   */
  timeouts?: Pick<RegisterOptions, "perStepTimeoutMs" | "perRunTimeoutMs">;
};

export type GenerateOptions = {
  frontendUrl?: string;
  timeouts?: Pick<RegisterOptions, "perStepTimeoutMs" | "perRunTimeoutMs">;
};

export type GenerateResult = {
  text: string;
  stats: RunStats;
};

/**
 * Folds a single step's tool calls and usage into a running `RunStats`
 * accumulator. Mutates `stats` in place. Used by `onStepFinish` so the
 * sink can observe partial progress without waiting for the final result.
 */
const accumulateStepStats = (
  stats: RunStats,
  step: {
    toolCalls?: Array<{ toolName: string }>;
    usage?: { inputTokens?: number; outputTokens?: number };
  },
): void => {
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
};

/**
 * Computes per-run statistics from an AI SDK result with `steps` and
 * `totalUsage`. Works for both stream and generate paths.
 */
const computeStats = (result: {
  steps: Array<{ toolCalls: Array<{ toolName: string }> }>;
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
  return {
    steps: result.steps.length,
    toolCalls: Array.from(toolCallCounts, ([name, count]) => ({ name, count })),
    inputTokens: result.totalUsage.inputTokens ?? 0,
    outputTokens: result.totalUsage.outputTokens ?? 0,
  };
};

/**
 * Derives the `user` argument expected by `prepareChatTurn` from the run
 * scope. For trigger and sub-agent principals the userId resolves through
 * `actorUserId` to the underlying human owner.
 */
const userFromScope = (scope: WorkspaceScope): { id: string; name: string } => {
  const p = scope.principal;
  if (p.kind === "user") return { id: p.userId, name: p.name };
  if (p.kind === "trigger") return { id: p.onBehalfOfUserId, name: p.name };
  return { id: actorUserId(scope.principal), name: "Sub-agent" };
};

/**
 * Builds the activity callback handed to `prepareChatTurn`. Every invocation
 * bumps the run's per-step stall timer. When the wrapper passes a tool
 * boundary event we also emit a structured log line — start events at debug
 * (noisy), end events at info with duration so post-mortem of a stalled run
 * shows exactly which tool was slow.
 */
const makeActivityHandler =
  (handle: RunHandle, runId: RunId) =>
  (event?: ToolActivityEvent): void => {
    handle.bumpStep();
    if (!event) return;
    if (event.phase === "start") {
      logger.debug({ runId, toolName: event.toolName }, "Tool call started");
    } else {
      logger.info(
        {
          runId,
          toolName: event.toolName,
          durationMs: event.durationMs,
        },
        "Tool call finished",
      );
    }
  };

/** Mutable per-run state shared by `setup`, the timeout handler, and the
 *  consumer-shaped entry point. A background timer (the timeout) and the
 *  foreground model call both read/write it, so it lives in one object both
 *  can reach. */
type RunState = {
  turn?: ChatTurn;
  stats: RunStats;
  messages: PlatypusUIMessage[];
  terminated: boolean;
};

/**
 * Orchestrates an end-to-end agent run.
 *
 * The runner wraps `prepareChatTurn` with a `RunSink` lifecycle and offers
 * two consumer-shaped entry points: `stream()` for HTTP streaming clients
 * and `generate()` for headless callers (triggers, sub-agents).
 *
 * Run lifetime is decoupled from the HTTP request: the runner registers
 * each run with `RunRegistry`, which owns the `AbortController` and the
 * per-step / per-run timeout timers. Cancellation goes through
 * `agentRunner.cancel(runId)` (e.g. from the chat cancel route).
 *
 * Out of scope (later PRs):
 * - Sub-agent runs as AgentRunner consumers (PR #4)
 */
export class AgentRunner {
  private async prepare(
    scope: WorkspaceScope,
    input: RunInput,
    origin: string | undefined,
    frontendUrl?: string,
    onActivity?: (event?: ToolActivityEvent) => void,
  ): Promise<ChatTurn> {
    return prepareChatTurn({
      orgId: scope.orgId,
      workspaceId: scope.workspaceId,
      user: userFromScope(scope),
      request: input.request,
      messages: input.messages,
      origin,
      frontendUrl,
      runMode: scope.principal.kind === "user" ? "interactive" : "headless",
      onActivity,
    });
  }

  /**
   * Cancel an in-flight run. Idempotent. Returns true if a run was
   * cancelled, false if the runId was unknown or already finished.
   */
  cancel(runId: RunId): boolean {
    return runRegistry.cancel(runId);
  }

  /**
   * Shared run scaffolding: the sink lifecycle (`onStart` → `onResolved`),
   * the registry + timeout wiring, `prepare`, the per-step callback, and the
   * once-only `finalize`. Both `stream` and `generate` build on this; only the
   * model invocation and the consumer-shaped return value differ.
   *
   * `finalize` and the timeout handler live here but read `state`, which the
   * caller keeps writing (the streamed messages) after `setup` returns — so a
   * timeout firing mid-stream still persists the partial answer.
   */
  private async setup(params: {
    scope: WorkspaceScope;
    input: RunInput;
    sink: RunSink;
    origin?: string;
    frontendUrl?: string;
    timeouts?: Pick<RegisterOptions, "perStepTimeoutMs" | "perRunTimeoutMs">;
    /**
     * Unattended (trigger/scheduled) runs enable no-progress detection: a
     * stuck model that re-issues the same call for the same result is aborted
     * before it burns compute up to the step ceiling. Interactive runs leave
     * it off — a human can stop those themselves.
     */
    unattended?: boolean;
  }) {
    const { scope, input, sink } = params;

    // File gate (issue #328): reject a turn carrying a file the target model
    // can't handle BEFORE the sink persists anything, so a bad attachment can
    // never brick the chat. Runs only when the turn has file parts; throws
    // `FileValidationError`, which propagates to the route as a 400.
    await validateTurnAttachments({
      request: input.request,
      messages: input.messages,
      orgId: scope.orgId,
      workspaceId: scope.workspaceId,
    });

    await sink.onStart({ runId: input.runId, messages: input.messages });

    const state: RunState = {
      stats: {},
      messages: input.messages,
      terminated: false,
    };

    const finalize = async (
      status: RunStatus,
      error?: Error,
    ): Promise<void> => {
      if (state.terminated) return;
      state.terminated = true;
      try {
        await state.turn?.dispose();
      } catch (err) {
        logger.error({ err, runId: input.runId }, "Error disposing turn");
      }
      try {
        await sink.onFinish({
          runId: input.runId,
          status,
          messages: state.messages,
          stats: state.stats,
          error,
        });
      } catch (err) {
        logger.error({ err, runId: input.runId }, "Error in onFinish");
      }
      runRegistry.unregister(input.runId);
    };

    const handle: RunHandle = runRegistry.register(input.runId, {
      ...params.timeouts,
      onTimeout: (error) => {
        logger.error(
          {
            runId: input.runId,
            kind: error.kind,
            message: error.message,
            stats: state.stats,
          },
          "Run timed out",
        );
        void finalize("failed", error);
      },
    });

    const onActivity = makeActivityHandler(handle, input.runId);

    try {
      state.turn = await this.prepare(
        scope,
        input,
        params.origin,
        params.frontendUrl,
        onActivity,
      );
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error(
        { error, runId: input.runId },
        "Run prepare failed before model invocation",
      );
      await finalize("failed", err);
      throw err;
    }

    const plan: ResolvedRunPlan = { resolved: state.turn.resolved };
    await sink.onResolved({ runId: input.runId, plan });

    const onStep = (step: {
      toolCalls?: Array<{ toolName: string }>;
      usage?: { inputTokens?: number; outputTokens?: number };
    }): void => {
      handle.bumpStep();
      accumulateStepStats(state.stats, step);
      logger.info(
        {
          runId: input.runId,
          step: state.stats.steps,
          toolCalls: step.toolCalls?.map((tc) => tc.toolName) ?? [],
          stats: state.stats,
        },
        "Step finished",
      );
      // Sink decides write cadence (FlushScheduler in ChatSink).
      void sink
        .onProgress({
          runId: input.runId,
          messages: state.messages,
          stats: state.stats,
        })
        .catch((err) =>
          logger.error({ err, runId: input.runId }, "Error in onProgress"),
        );
    };

    // Unattended runs gain a second stop condition alongside the step
    // ceiling: when the model makes no progress (same call → same result,
    // K times) the loop halts before issuing yet another wasteful step.
    // `tripped()` is read after generation to record the run as failed.
    const noProgress: NoProgressDetector | null = params.unattended
      ? createNoProgressDetector()
      : null;

    // Built once and shared by both invocations. Generation params pass
    // through as-is (including `undefined`): the SDK treats an absent key and
    // an `undefined` value identically, and the streaming path has always
    // passed them this way in production.
    const modelArgs = {
      model: state.turn.stream.model,
      messages: await convertToModelMessages(state.turn.stream.messages),
      system: state.turn.stream.system,
      tools: state.turn.stream.tools,
      stopWhen: noProgress
        ? [stepCountIs(state.turn.stream.maxSteps), noProgress.stopCondition]
        : [stepCountIs(state.turn.stream.maxSteps)],
      abortSignal: handle.signal,
      temperature: state.turn.stream.temperature,
      topP: state.turn.stream.topP,
      topK: state.turn.stream.topK,
      frequencyPenalty: state.turn.stream.frequencyPenalty,
      presencePenalty: state.turn.stream.presencePenalty,
      seed: state.turn.stream.seed,
    };

    return { state, handle, finalize, onStep, modelArgs, noProgress };
  }

  async stream(params: {
    scope: WorkspaceScope;
    input: RunInput;
    sink: RunSink;
    options: StreamOptions;
  }): Promise<Response> {
    const { input, options } = params;
    const { state, handle, finalize, onStep, modelArgs } = await this.setup({
      scope: params.scope,
      input,
      sink: params.sink,
      origin: options.origin,
      frontendUrl: options.frontendUrl,
      timeouts: options.timeouts,
    });

    logger.debug({ systemPrompt: modelArgs.system }, "System prompt for chat");

    const result = streamText({
      ...modelArgs,
      onStepFinish: (step) => onStep(step),
    });

    // Build the UI message stream and tee it. The response body consumes
    // one branch; we drain the other server-side so a disconnected
    // client (cancelling the response branch) doesn't propagate back to
    // the source. The source keeps pulling as long as the snapshot
    // branch is being read, so `onFinish` only fires on natural
    // completion — not when the consumer cancels with partial state.
    const uiStream = result.toUIMessageStream<PlatypusUIMessage>({
      originalMessages: input.messages,
      generateMessageId: createIdGenerator({ prefix: "msg", size: 16 }),
      messageMetadata: () =>
        state.turn?.resolved.agentId
          ? { agentId: state.turn.resolved.agentId }
          : undefined,
      onError: (error) => formatStreamError(error),
      onFinish: async ({ messages: finalMessages }) => {
        state.messages = finalMessages;
        let status: RunStatus = "succeeded";
        let err: Error | undefined;
        if (handle.signal.aborted) {
          const reason: unknown = handle.signal.reason;
          if (reason instanceof TimeoutError) {
            status = "failed";
            err = reason;
          } else {
            status = "cancelled";
          }
        }
        await finalize(status, err);
      },
    });

    const [forResponse, forSnapshot] = uiStream.tee();

    // Read the snapshot branch as message snapshots and keep `state.messages`
    // up to date. ChatSink's FlushScheduler then writes the in-progress
    // assistant message to the DB on each onProgress bump, so a user who
    // reconnects mid-run sees the partial answer (not just their own
    // input message).
    void (async () => {
      try {
        for await (const message of readUIMessageStream<PlatypusUIMessage>({
          stream: forSnapshot,
          onError: (err) =>
            logger.error(
              { err, runId: input.runId },
              "Snapshot stream parse error",
            ),
        })) {
          state.messages = [...input.messages, message];
        }
      } catch (err) {
        logger.error(
          { err, runId: input.runId },
          "Server-side UI stream consumer error",
        );
      }
    })();

    return createUIMessageStreamResponse({ stream: forResponse });
  }

  /**
   * Headless run that awaits a final result. Always reaches `sink.onFinish`
   * and disposes MCP clients in a `finally`.
   */
  async generate(params: {
    scope: WorkspaceScope;
    input: RunInput;
    sink: RunSink;
    options?: GenerateOptions;
  }): Promise<GenerateResult> {
    const { input } = params;
    const options = params.options ?? {};
    // No `origin`: headless callers don't have file URLs to inline.
    // Headless runs are unattended → enable no-progress detection.
    const { state, handle, finalize, onStep, modelArgs, noProgress } =
      await this.setup({
        scope: params.scope,
        input,
        sink: params.sink,
        frontendUrl: options.frontendUrl,
        timeouts: options.timeouts,
        unattended: true,
      });

    const startTime = Date.now();
    try {
      const result = await generateText({
        ...modelArgs,
        onStepFinish: (step) => onStep(step),
      });

      const stats = computeStats(result as Parameters<typeof computeStats>[0]);
      state.stats = stats;

      // The no-progress stop condition halts the loop cleanly (the SDK
      // resolves normally), so the abort is surfaced here rather than via the
      // catch path. Record the run as failed with a machine-readable reason.
      const trip = noProgress?.tripped() ?? null;
      if (trip) {
        const err = new NoProgressError(trip.toolName, trip.count);
        logger.warn(
          {
            runId: input.runId,
            toolName: trip.toolName,
            count: trip.count,
            duration: Date.now() - startTime,
            stats,
          },
          "Run aborted: no progress",
        );
        await finalize("failed", err);
        return { text: result.text, stats };
      }

      logger.info(
        {
          runId: input.runId,
          duration: Date.now() - startTime,
          responseLength: result.text.length,
          stats,
        },
        "Run generate completed",
      );

      await finalize("succeeded");
      return { text: result.text, stats };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error(
        {
          error,
          runId: input.runId,
          duration: Date.now() - startTime,
        },
        "Run generate failed",
      );
      let status: RunStatus = "failed";
      if (
        handle.signal.aborted &&
        !(handle.signal.reason instanceof TimeoutError)
      ) {
        status = "cancelled";
      }
      await finalize(status, err);
      throw err;
    }
  }
}

/**
 * Converts AI SDK errors into user-facing strings for the UI message stream.
 * Behaviour-preserving copy of the previous inline `onError` handler.
 */
const formatStreamError = (error: unknown): string => {
  logger.error({ error }, "Chat stream error");
  if (LoadAPIKeyError.isInstance(error)) {
    return "AI provider API key is missing or not configured.";
  }
  if (APICallError.isInstance(error)) {
    if (error.statusCode === 401 || error.statusCode === 403) {
      return "AI provider authentication failed. Your API key may be invalid or expired.";
    }
    if (error.statusCode === 429) {
      return "AI provider rate limit exceeded. Please try again later.";
    }
    if (error.statusCode != null && error.statusCode >= 500) {
      return "AI provider is currently unavailable. Please try again later.";
    }
    return `AI provider error: ${error.message}`;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return "An unexpected error occurred.";
};

/** Singleton runner — services and routes share one instance. */
export const agentRunner = new AgentRunner();
