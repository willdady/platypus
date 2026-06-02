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
  type LanguageModel,
  type UIMessageChunk,
} from "ai";
import {
  prepareChatTurn,
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
import type {
  ResolvedRunPlan,
  RunId,
  RunInput,
  RunSink,
  RunStats,
  RunStatus,
} from "./types.ts";

/**
 * Returns a new RunInput with `createdAt` stamped on the last user message
 * if it doesn't already have one. Non-mutating — caller's input is preserved.
 *
 * Client-side stamping (see chat.tsx) covers normal flow; this is a fallback
 * for older clients or other callers that don't set `metadata.createdAt`.
 */
function stampLastUserMessageCreatedAt(input: RunInput): RunInput {
  const lastIdx = input.messages.length - 1;
  if (lastIdx < 0) return input;
  const last = input.messages[lastIdx];
  const existing = last.metadata as Record<string, unknown> | undefined;
  if (last.role !== "user" || existing?.createdAt) return input;
  const stamped = {
    ...last,
    metadata: { ...existing, createdAt: new Date().toISOString() },
  };
  return {
    ...input,
    messages: [...input.messages.slice(0, lastIdx), stamped],
  };
}

/**
 * Injects startedAt into tool-input-available chunks via toolMetadata.
 * Must be on tool-input-available (not -output-available) because the AI SDK's
 * tool-output-available handler ignores chunk.toolMetadata and reuses the
 * invocation's existing toolMetadata from the input-available phase.
 *
 * Exported for unit testing.
 */
export function withToolTimestamps<TChunk extends UIMessageChunk>(
  stream: ReadableStream<TChunk>,
  now: () => string = () => new Date().toISOString(),
): ReadableStream<TChunk> {
  return stream.pipeThrough(
    new TransformStream<TChunk, TChunk>({
      transform(chunk, controller) {
        if (chunk.type === "tool-input-available") {
          controller.enqueue({
            ...chunk,
            toolMetadata: {
              ...chunk.toolMetadata,
              startedAt: now(),
            },
          });
        } else {
          controller.enqueue(chunk);
        }
      },
    }),
  );
}

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

  async stream(params: {
    scope: WorkspaceScope;
    input: RunInput;
    sink: RunSink;
    options: StreamOptions;
  }): Promise<Response> {
    const { scope, sink, options } = params;
    const input = stampLastUserMessageCreatedAt(params.input);

    await sink.onStart({ runId: input.runId, messages: input.messages });

    let turn: ChatTurn | undefined;
    let lastMessages: PlatypusUIMessage[] = input.messages;
    let lastStats: RunStats = {};
    let terminated = false;

    const finalize = async (
      status: RunStatus,
      error?: Error,
    ): Promise<void> => {
      if (terminated) return;
      terminated = true;
      try {
        await turn?.dispose();
      } catch (err) {
        logger.error({ err, runId: input.runId }, "Error disposing turn");
      }
      try {
        await sink.onFinish({
          runId: input.runId,
          status,
          messages: lastMessages,
          stats: lastStats,
          error,
        });
      } catch (err) {
        logger.error({ err, runId: input.runId }, "Error in stream onFinish");
      }
      runRegistry.unregister(input.runId);
    };

    const handle: RunHandle = runRegistry.register(input.runId, {
      ...options.timeouts,
      onTimeout: (error) => {
        logger.error(
          {
            runId: input.runId,
            kind: error.kind,
            message: error.message,
            stats: lastStats,
          },
          "Run timed out",
        );
        void finalize("failed", error);
      },
    });

    const onActivity = makeActivityHandler(handle, input.runId);

    try {
      turn = await this.prepare(
        scope,
        input,
        options.origin,
        options.frontendUrl,
        onActivity,
      );
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      await finalize("failed", err);
      throw err;
    }

    const plan: ResolvedRunPlan = { resolved: turn.resolved };
    await sink.onResolved({ runId: input.runId, plan });

    logger.debug(
      { systemPrompt: turn.stream.system },
      "System prompt for chat",
    );

    const result = streamText({
      model: turn.stream.model,
      messages: await convertToModelMessages(turn.stream.messages),
      stopWhen: [stepCountIs(turn.stream.maxSteps)],
      tools: turn.stream.tools,
      system: turn.stream.system,
      abortSignal: handle.signal,
      temperature: turn.stream.temperature,
      topP: turn.stream.topP,
      topK: turn.stream.topK,
      frequencyPenalty: turn.stream.frequencyPenalty,
      presencePenalty: turn.stream.presencePenalty,
      seed: turn.stream.seed,
      onStepFinish: (step) => {
        handle.bumpStep();
        accumulateStepStats(lastStats, step);
        logger.info(
          {
            runId: input.runId,
            step: lastStats.steps,
            toolCalls: step.toolCalls?.map((tc) => tc.toolName) ?? [],
            stats: lastStats,
          },
          "Step finished",
        );
        // Sink decides write cadence (FlushScheduler in ChatSink).
        void sink
          .onProgress({
            runId: input.runId,
            messages: lastMessages,
            stats: lastStats,
          })
          .catch((err) =>
            logger.error(
              { err, runId: input.runId },
              "Error in stream onProgress",
            ),
          );
      },
    });

    // Build the UI message stream and tee it. The response body consumes
    // one branch; we drain the other server-side so a disconnected
    // client (cancelling the response branch) doesn't propagate back to
    // the source. The source keeps pulling as long as the snapshot
    // branch is being read, so `onFinish` only fires on natural
    // completion — not when the consumer cancels with partial state.
    // Capture createdAt ONCE (not inside messageMetadata callback). The AI SDK
    // invokes the callback for both `start` and `finish` chunks; calling
    // `new Date()` each time would store the finish time and mislabel it as
    // createdAt — which can be minutes off for long agent runs.
    const assistantCreatedAt = new Date().toISOString();
    const uiStream = result.toUIMessageStream<PlatypusUIMessage>({
      originalMessages: input.messages,
      generateMessageId: createIdGenerator({ prefix: "msg", size: 16 }),
      messageMetadata: () => ({
        ...(turn.resolved.agentId ? { agentId: turn.resolved.agentId } : {}),
        createdAt: assistantCreatedAt,
      }),
      onError: (error) => formatStreamError(error),
    });

    const [forResponse, forSnapshot] = withToolTimestamps(uiStream).tee();

    // Read the snapshot branch as message snapshots and keep `lastMessages`
    // up to date. ChatSink's FlushScheduler then writes the in-progress
    // assistant message to the DB on each onProgress bump, so a user who
    // reconnects mid-run sees the partial answer (not just their own
    // input message).
    //
    // finalize is called here (not in toUIMessageStream's onFinish) so that
    // lastMessages contains toolMetadata timestamps injected by withToolTimestamps.
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
          lastMessages = [...input.messages, message];
        }
      } catch (err) {
        logger.error(
          { err, runId: input.runId },
          "Server-side UI stream consumer error",
        );
      } finally {
        let status: RunStatus = "succeeded";
        let err: Error | undefined;
        if (handle.signal.aborted) {
          const reason = handle.signal.reason;
          if (reason instanceof TimeoutError) {
            status = "failed";
            err = reason;
          } else {
            status = "cancelled";
          }
        }
        await finalize(status, err);
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
    const { scope, input, sink } = params;
    const options = params.options ?? {};

    await sink.onStart({ runId: input.runId, messages: input.messages });

    let turn: ChatTurn | undefined;
    let lastStats: RunStats = {};
    let terminated = false;

    const finalize = async (
      status: RunStatus,
      error?: Error,
    ): Promise<void> => {
      if (terminated) return;
      terminated = true;
      try {
        await sink.onFinish({
          runId: input.runId,
          status,
          messages: [],
          stats: lastStats,
          error,
        });
      } catch (err) {
        logger.error({ err, runId: input.runId }, "Error in generate onFinish");
      }
      runRegistry.unregister(input.runId);
    };

    const handle: RunHandle = runRegistry.register(input.runId, {
      ...options.timeouts,
      onTimeout: (error) => {
        logger.error(
          {
            runId: input.runId,
            kind: error.kind,
            message: error.message,
            stats: lastStats,
          },
          "Run timed out",
        );
        void finalize("failed", error);
      },
    });

    const onActivity = makeActivityHandler(handle, input.runId);

    try {
      // No `origin`: headless callers don't have file URLs to inline.
      turn = await this.prepare(
        scope,
        input,
        undefined,
        options.frontendUrl,
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

    const plan: ResolvedRunPlan = { resolved: turn.resolved };
    await sink.onResolved({ runId: input.runId, plan });

    const startTime = Date.now();
    try {
      const result = await generateText({
        model: turn.stream.model as LanguageModel,
        messages: await convertToModelMessages(turn.stream.messages),
        tools: turn.stream.tools,
        system: turn.stream.system,
        stopWhen: [stepCountIs(turn.stream.maxSteps)],
        abortSignal: handle.signal,
        onStepFinish: (step) => {
          handle.bumpStep();
          accumulateStepStats(lastStats, step);
          logger.info(
            {
              runId: input.runId,
              step: lastStats.steps,
              toolCalls: step.toolCalls?.map((tc) => tc.toolName) ?? [],
              stats: lastStats,
            },
            "Step finished",
          );
          void sink
            .onProgress({
              runId: input.runId,
              messages: [],
              stats: lastStats,
            })
            .catch((err) =>
              logger.error(
                { err, runId: input.runId },
                "Error in generate onProgress",
              ),
            );
        },
        ...Object.fromEntries(
          Object.entries({
            temperature: turn.stream.temperature,
            topP: turn.stream.topP,
            topK: turn.stream.topK,
            frequencyPenalty: turn.stream.frequencyPenalty,
            presencePenalty: turn.stream.presencePenalty,
          }).filter(([, v]) => v !== undefined),
        ),
      });

      const stats = computeStats(result as any);
      lastStats = stats;
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
    } finally {
      try {
        await turn?.dispose();
      } catch (err) {
        logger.error(
          { err, runId: input.runId },
          "Error disposing turn after generate",
        );
      }
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
