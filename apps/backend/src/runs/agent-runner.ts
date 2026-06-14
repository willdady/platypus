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
  wrapLanguageModel,
  type LanguageModel,
  type UIMessageChunk,
} from "ai";
import {
  contextOverflowRecoveryMiddleware,
  isContextOverflowError,
} from "./recovery.ts";
import {
  buildTier2PrepareStep,
  COMPACT_CONTEXT_TOOL_NAME,
  type CompactionTrace,
} from "./compaction.ts";
import {
  loadChatMessages,
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
 * Result of {@link withToolTimestamps}: the transformed stream plus a map of
 * `toolCallId` → completion ISO timestamp, populated as tool-output chunks
 * pass through.
 */
export type ToolTimestampStream<TChunk extends UIMessageChunk> = {
  stream: ReadableStream<TChunk>;
  /** toolCallId → completedAt ISO timestamp, filled in as the stream drains. */
  completions: Map<string, string>;
};

/**
 * Stamps tool-call timing onto the stream so the UI can show each tool's run
 * duration:
 *
 * - `startedAt` is injected into `tool-input-available` chunks via
 *   `toolMetadata`. It must go here (not on the output chunk) because the AI
 *   SDK's tool-output handlers ignore `chunk.toolMetadata` and reuse the
 *   invocation's existing `toolMetadata` from the input-available phase.
 * - `completedAt` cannot ride the output chunk for the same reason, so it is
 *   recorded in the returned `completions` map keyed by `toolCallId`. The run
 *   loop applies it to the built message via {@link applyToolCompletions}
 *   before the sink persists it.
 *
 * Exported for unit testing.
 */
export function withToolTimestamps<TChunk extends UIMessageChunk>(
  stream: ReadableStream<TChunk>,
  now: () => string = () => new Date().toISOString(),
): ToolTimestampStream<TChunk> {
  const completions = new Map<string, string>();
  const out = stream.pipeThrough(
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
          return;
        }
        if (
          chunk.type === "tool-output-available" ||
          chunk.type === "tool-output-error"
        ) {
          completions.set(chunk.toolCallId, now());
        }
        controller.enqueue(chunk);
      },
    }),
  );
  return { stream: out, completions };
}

/**
 * Injects synthetic `compact_context` tool-call + tool-result chunks into a
 * UIMessage stream immediately after the `start` event (§K / 11c). Makes Tier
 * 1 compaction visible in the chat timeline without a custom renderer — the
 * existing tool-call expander handles it automatically.
 *
 * Exported for unit testing.
 */
export function prependCompactionChunks(
  stream: ReadableStream<UIMessageChunk>,
  trace: CompactionTrace,
  generateId: () => string = createIdGenerator({ prefix: "cc", size: 12 }),
): ReadableStream<UIMessageChunk> {
  const toolCallId = generateId();
  const syntheticChunks: UIMessageChunk[] = [
    {
      type: "tool-input-available",
      toolCallId,
      toolName: COMPACT_CONTEXT_TOOL_NAME,
      title: "Context compaction",
      input: { messagesDropped: trace.messagesDropped },
    },
    {
      type: "tool-output-available",
      toolCallId,
      output: {
        messagesDropped: trace.messagesDropped,
        ...(trace.summaryExcerpt
          ? { summaryExcerpt: trace.summaryExcerpt }
          : {}),
      },
    },
  ];
  let injected = false;
  return stream.pipeThrough(
    new TransformStream<UIMessageChunk, UIMessageChunk>({
      transform(chunk, controller) {
        controller.enqueue(chunk);
        if (!injected && chunk.type === "start") {
          injected = true;
          for (const c of syntheticChunks) controller.enqueue(c);
        }
      },
    }),
  );
}

const COMPACT_CONTEXT_PART_TYPE = `tool-${COMPACT_CONTEXT_TOOL_NAME}`;

/**
 * Removes the synthetic `compact_context` trace parts (§K/11c) from a message
 * list before it is converted to ModelMessages. The trace is a UI-only marker
 * persisted in the assistant message for the chat timeline; it must NEVER be
 * replayed to the provider, which would otherwise see a phantom tool call for a
 * tool it was never given (provider rejection / model confusion). An assistant
 * message left with no parts after stripping (the §J standalone trace message)
 * is dropped entirely rather than sent empty.
 *
 * Exported for unit testing.
 */
export function stripCompactionTraceParts(
  messages: PlatypusUIMessage[],
): PlatypusUIMessage[] {
  let changed = false;
  const out: PlatypusUIMessage[] = [];
  for (const message of messages) {
    if (
      message.role !== "assistant" ||
      !message.parts.some((p) => p.type === COMPACT_CONTEXT_PART_TYPE)
    ) {
      out.push(message);
      continue;
    }
    changed = true;
    const parts = message.parts.filter(
      (p) => p.type !== COMPACT_CONTEXT_PART_TYPE,
    );
    if (parts.length > 0) out.push({ ...message, parts });
    // else: trace-only message (§J) — drop it from the model payload.
  }
  return changed ? out : messages;
}

/** Stats stamped on the last assistant message's metadata after each stream (§H/§I). */
export type MessageStats = {
  /** Run-wide totals across every step (sum) — §I cost popover. */
  inputTokens: number;
  outputTokens: number;
  /**
   * Input tokens of the LAST model call = peak context fullness — §H ring.
   * NOT the run-wide sum (which over-counts on multi-step tool loops).
   */
  contextTokens: number;
  startedAt: string;
  firstTokenAt?: string;
  finishedAt: string;
  contextWindow: number;
  contextWindowIsDefault: boolean;
};

/**
 * Stamps per-run stats (token counts, timing, resolved context window) onto
 * the last assistant message's `metadata.stats` in place. Applied at the same
 * point as {@link applyToolCompletions} so both mutations happen before the
 * sink persists the final state (§H/§I).
 */
function applyMessageStats(
  messages: PlatypusUIMessage[],
  stats: MessageStats,
): void {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") {
      const msg = messages[i] as PlatypusUIMessage & {
        metadata?: Record<string, unknown>;
      };
      msg.metadata = { ...msg.metadata, stats };
      return;
    }
  }
}

/**
 * Stamps `completedAt` onto assistant tool parts in place, reading from the
 * `completions` map produced by {@link withToolTimestamps}. Applied to the
 * built message just before it is persisted, since the AI SDK strips
 * `toolMetadata` from tool-output chunks and the end time can't be injected
 * inline. Paired with the injected `startedAt`, this lets the UI compute each
 * tool's run duration.
 */
function applyToolCompletions(
  messages: PlatypusUIMessage[],
  completions: Map<string, string>,
): void {
  if (completions.size === 0) return;
  for (const message of messages) {
    for (const part of message.parts ?? []) {
      const anyPart = part as {
        toolCallId?: string;
        toolMetadata?: Record<string, unknown>;
      };
      const completedAt = anyPart.toolCallId
        ? completions.get(anyPart.toolCallId)
        : undefined;
      if (!completedAt) continue;
      anyPart.toolMetadata = { ...anyPart.toolMetadata, completedAt };
    }
  }
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

/** Mutable per-run state shared by `setup`, the timeout handler, and the
 *  consumer-shaped entry point. A background timer (the timeout) and the
 *  foreground model call both read/write it, so it lives in one object both
 *  can reach. */
type RunState = {
  turn?: ChatTurn;
  stats: RunStats;
  messages: PlatypusUIMessage[];
  terminated: boolean;
  /**
   * Input tokens reported by the most recent model step = peak context
   * fullness for the §H ring. Tracked separately from `stats.inputTokens`,
   * which is the run-wide SUM and over-counts multi-step tool loops.
   */
  lastStepInputTokens: number;
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
    priorMessages?: PlatypusUIMessage[],
    signal?: AbortSignal,
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
      priorMessages,
      signal,
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
  }) {
    const { scope, input, sink } = params;

    // RV1: snapshot the DB state BEFORE onStart overwrites it so
    // applyTier1IfNeeded has the correct C4 baseline. Only interactive chats
    // carry a `request.id`; headless runs (triggers, sub-agents) have none.
    const priorMessages = input.request.id
      ? await loadChatMessages(input.request.id).catch((err) => {
          // Falls back to the post-overwrite DB read inside applyTier1IfNeeded,
          // which cannot detect edits below the watermark — log the degradation.
          logger.warn(
            { err, chatId: input.request.id },
            "RV1: failed to snapshot prior messages; C4 edit-detection degraded this turn",
          );
          return undefined;
        })
      : undefined;

    await sink.onStart({ runId: input.runId, messages: input.messages });

    const state: RunState = {
      stats: {},
      messages: input.messages,
      terminated: false,
      lastStepInputTokens: 0,
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
        priorMessages,
        handle.signal,
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
      state.lastStepInputTokens =
        step.usage?.inputTokens ?? state.lastStepInputTokens;
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

    // Built once and shared by both invocations. Generation params pass
    // through as-is (including `undefined`): the SDK treats an absent key and
    // an `undefined` value identically, and the streaming path has always
    // passed them this way in production.
    const modelArgs = {
      // Recovery middleware (§E, P4): every model call — first call and every
      // tool-loop step, stream and generate alike — gets one trim-and-retry on
      // a provider "context too long" rejection. Always on; not gated by §G.
      model: withOverflowRecovery(state.turn),
      // Strip the UI-only synthetic compact_context trace parts (§K/11c) before
      // sending history to the provider — replaying them surfaces a phantom tool
      // call for a tool the model was never given. Applied here so both the
      // streaming and generate paths (which share modelArgs) are covered.
      messages: await convertToModelMessages(
        stripCompactionTraceParts(state.turn.stream.messages),
      ),
      system: state.turn.stream.system,
      tools: state.turn.stream.tools,
      stopWhen: [stepCountIs(state.turn.stream.maxSteps)],
      abortSignal: handle.signal,
      // Tier 2 (§D): in-turn compaction before each step when the live window
      // nears the limit. Undefined when the turn has no Tier 2 runtime.
      prepareStep: state.turn.tier2
        ? buildTier2PrepareStep(state.turn.tier2)
        : undefined,
      temperature: state.turn.stream.temperature,
      topP: state.turn.stream.topP,
      topK: state.turn.stream.topK,
      frequencyPenalty: state.turn.stream.frequencyPenalty,
      presencePenalty: state.turn.stream.presencePenalty,
      seed: state.turn.stream.seed,
    };

    return { state, handle, finalize, onStep, modelArgs };
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

    const startedAt = new Date().toISOString();
    let firstTokenAt: string | undefined;
    // Set when the §H/§I stats are first emitted (messageMetadata `finish`), so
    // the post-stream persist stamp reuses the same value rather than a slightly
    // later one — streamed and reloaded stats then match.
    let finishedAt: string | undefined;

    // Single source of truth for the per-message stats, so the live-streamed
    // copy (messageMetadata, below) and the persisted copy (applyMessageStats in
    // the finally) are identical. Reads the mutable state at call time.
    const buildMessageStats = (
      finishedAtValue: string,
    ): MessageStats | undefined => {
      if (!state.turn) return undefined;
      return {
        inputTokens: state.stats.inputTokens ?? 0,
        outputTokens: state.stats.outputTokens ?? 0,
        contextTokens: state.lastStepInputTokens,
        startedAt,
        firstTokenAt,
        finishedAt: finishedAtValue,
        contextWindow: state.turn.resolved.contextWindow,
        contextWindowIsDefault: state.turn.resolved.contextWindowIsDefault,
      };
    };

    const result = streamText({
      ...modelArgs,
      onStepFinish: (step) => onStep(step),
      // TTFT: stamp the first text token here (fires before the `finish` event),
      // so the stats are complete by the time messageMetadata emits them.
      onChunk: ({ chunk }) => {
        if (!firstTokenAt && chunk.type === "text-delta") {
          firstTokenAt = new Date().toISOString();
        }
      },
    });

    // Build the UI message stream and tee it. The response body consumes
    // one branch; we drain the other server-side so a disconnected
    // client (cancelling the response branch) doesn't propagate back to
    // the source. The source keeps pulling as long as the snapshot
    // branch is being read.
    const uiStream = result.toUIMessageStream<PlatypusUIMessage>({
      originalMessages: input.messages,
      generateMessageId: createIdGenerator({ prefix: "msg", size: 16 }),
      // Emit the §H/§I stats with the `finish` event so the client gets them on
      // the final stream chunk — the (i) stats action then appears the instant
      // the answer completes, not a DB-refetch round-trip later. `start` carries
      // only agentId (timing/usage don't exist yet). The post-stream stamp in
      // the finally still writes them to the persisted message for reload.
      messageMetadata: ({ part }) => {
        const agentId = state.turn?.resolved.agentId
          ? { agentId: state.turn.resolved.agentId }
          : undefined;
        if (part.type === "finish") {
          finishedAt = new Date().toISOString();
          const stats = buildMessageStats(finishedAt);
          return stats ? { ...agentId, stats } : agentId;
        }
        return agentId;
      },
      onError: (error) => formatStreamError(error),
    });

    // §K / 11c: if Tier 1 compaction fired this turn, prepend synthetic
    // compact_context tool-call + tool-result chunks so the compaction is
    // visible in the chat timeline. Injected after the 'start' event so the
    // AI SDK builds them into the same assistant message as the response.
    const tracedStream: ReadableStream<UIMessageChunk> = state.turn
      ?.compactionTrace
      ? prependCompactionChunks(
          uiStream as ReadableStream<UIMessageChunk>,
          state.turn.compactionTrace,
        )
      : (uiStream as ReadableStream<UIMessageChunk>);

    const { stream: timedStream, completions } =
      withToolTimestamps(tracedStream);
    const [forResponse, forSnapshot] = timedStream.tee();

    // Read the snapshot branch as message snapshots and keep `state.messages`
    // up to date. ChatSink's FlushScheduler then writes the in-progress
    // assistant message to the DB on each onProgress bump, so a user who
    // reconnects mid-run sees the partial answer (not just their own
    // input message).
    //
    // finalize is called here (not in toUIMessageStream's onFinish) so that
    // state.messages reflects the fully-drained stream — including the tool
    // `completedAt` timestamps and §H/§I stats applied below — before the sink
    // persists it.
    // RV8: an error chunk (model/tool failure surfaced via formatStreamError) or
    // an internal stream fault ends the for-await without throwing, because
    // readUIMessageStream defaults terminateOnError=false. Capture it so the
    // finally finalizes "failed" instead of silently persisting a partial
    // message as "succeeded".
    let streamError: unknown;
    void (async () => {
      try {
        for await (const message of readUIMessageStream<PlatypusUIMessage>({
          stream: forSnapshot,
          onError: (err) => {
            streamError = err;
            logger.error(
              { err, runId: input.runId },
              "Snapshot stream parse error",
            );
          },
        })) {
          state.messages = [...input.messages, message];
        }
      } catch (err) {
        streamError = err;
        logger.error(
          { err, runId: input.runId },
          "Server-side UI stream consumer error",
        );
      } finally {
        // Reuse the finish-event timestamp when present so the persisted stats
        // match what was streamed; fall back if the stream ended without one.
        const finishedAtFinal = finishedAt ?? new Date().toISOString();
        applyToolCompletions(state.messages, completions);
        const stats = buildMessageStats(finishedAtFinal);
        if (stats) applyMessageStats(state.messages, stats);
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
        } else if (streamError !== undefined) {
          // The stream errored (model/tool rejection or internal fault) but did
          // not abort — record the run as failed rather than succeeded (RV8).
          status = "failed";
          err =
            streamError instanceof Error
              ? streamError
              : new Error(
                  typeof streamError === "string"
                    ? streamError
                    : "Server-side UI stream error",
                );
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
    const { input } = params;
    const options = params.options ?? {};
    // No `origin`: headless callers don't have file URLs to inline.
    const { state, handle, finalize, onStep, modelArgs } = await this.setup({
      scope: params.scope,
      input,
      sink: params.sink,
      frontendUrl: options.frontendUrl,
      timeouts: options.timeouts,
    });

    const startTime = Date.now();
    try {
      const result = await generateText({
        ...modelArgs,
        onStepFinish: (step) => onStep(step),
      });

      const stats = computeStats(result as Parameters<typeof computeStats>[0]);
      state.stats = stats;
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
 * Wraps the turn's model with the context-overflow recovery middleware (§E,
 * P4): every model call — first call and every tool-loop step, stream and
 * generate alike — gets one trim-and-retry on a provider "context too long"
 * rejection. Always on; the §G kill switch does not gate it.
 */
const withOverflowRecovery = (turn: ChatTurn): LanguageModel =>
  wrapLanguageModel({
    // turn.stream.model is typed `LanguageModel` (string | model spec); at this
    // point it is always a resolved model object, never a string id — narrow to
    // the spec form wrapLanguageModel requires.
    model: turn.stream.model as Parameters<
      typeof wrapLanguageModel
    >[0]["model"],
    middleware: contextOverflowRecoveryMiddleware(turn.recovery),
  });

/**
 * Converts AI SDK errors into user-facing strings for the UI message stream.
 * Behaviour-preserving copy of the previous inline `onError` handler.
 */
const formatStreamError = (error: unknown): string => {
  logger.error({ error }, "Chat stream error");
  if (LoadAPIKeyError.isInstance(error)) {
    return "AI provider API key is missing or not configured.";
  }
  // Reaching here means recovery (§E) already trimmed and retried once and the
  // provider still rejected the prompt — surface the actionable dead end.
  if (isContextOverflowError(error)) {
    return "Conversation too large for the model's context window even after trimming — start a new chat or reduce attachments.";
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
