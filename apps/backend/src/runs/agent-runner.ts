import {
  APICallError,
  LoadAPIKeyError,
  convertToModelMessages,
  createIdGenerator,
  createUIMessageStream,
  createUIMessageStreamResponse,
  generateText,
  readUIMessageStream,
  stepCountIs,
  streamText,
  wrapLanguageModel,
  type LanguageModel,
  type UIMessageStreamWriter,
} from "ai";
import {
  contextOverflowRecoveryMiddleware,
  isContextOverflowError,
} from "./recovery.ts";
import {
  buildTier2PrepareStep,
  COMPACT_CONTEXT_TOOL_NAME,
  compactionTracePayloads,
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

/** Before-stats carried by the one-shot compaction-summarize callback (ADR-0012 §Compaction trace in the timeline live In-Progress). */
type CompactionBeforeStats = { tokensBefore: number; messagesBefore: number };

/**
 * Resolves the live in-progress `compact_context` chunk (ADR-0012 §Compaction
 * trace in the timeline). Once the in-progress chunk has been written (i.e. a
 * model summary began → `toolCallId` is set), a terminal chunk MUST always
 * follow, otherwise the badge hangs on a permanent "Running" spinner. Two live
 * paths write in-progress but yield no trace: a concurrent CAS writer advancing
 * the version (summary ran, commit skipped) and a swallowed `summarize` throw —
 * both leave `prepare` succeeding with `compactionTrace: undefined`. In those
 * cases the in-memory view WAS compacted this turn, so a benign Done reads truer
 * than an error badge.
 */
function finalizeCompactionTrace(
  writer: UIMessageStreamWriter<PlatypusUIMessage>,
  toolCallId: string | undefined,
  trace: CompactionTrace | undefined,
): void {
  if (!toolCallId) return; // Stage 2 never ran → no spinner to close.
  if (trace) {
    const { output } = compactionTracePayloads(trace);
    writer.write({ type: "tool-output-available", toolCallId, output });
  } else {
    writer.write({
      type: "tool-output-available",
      toolCallId,
      output: {
        note: "Context compaction ran; summary not persisted this turn.",
      },
    });
  }
}

const COMPACT_CONTEXT_PART_TYPE = `tool-${COMPACT_CONTEXT_TOOL_NAME}`;

/**
 * Removes the synthetic `compact_context` trace parts (ADR-0012 §Compaction trace in the timeline) from a message
 * list before it is converted to ModelMessages. The trace is a UI-only marker
 * persisted in the assistant message for the chat timeline; it must NEVER be
 * replayed to the provider, which would otherwise see a phantom tool call for a
 * tool it was never given (provider rejection / model confusion). An assistant
 * message left with no parts after stripping (the ADR-0012 §Force-compact on demand standalone trace message)
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
    // else: trace-only message (ADR-0012 §Force-compact on demand) — drop it from the model payload.
  }
  return changed ? out : messages;
}

/** Stats stamped on the last assistant message's metadata after each stream (ADR-0012 §Context-usage ring / §Per-message stats). */
export type MessageStats = {
  /** Run-wide totals across every step (sum) — ADR-0012 §Per-message stats cost popover. */
  inputTokens: number;
  outputTokens: number;
  /**
   * Input tokens of the LAST model call = peak context fullness — ADR-0012 §Context-usage ring.
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
 * sink persists the final state (ADR-0012 §Context-usage ring / §Per-message stats).
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
   * fullness for the ADR-0012 §Context-usage ring. Tracked separately from `stats.inputTokens`,
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
    onCompactionSummarizeStart?: (before: CompactionBeforeStats) => void,
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
      onCompactionSummarizeStart,
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

    // ADR-0012 §Summary invalidation: snapshot the DB state BEFORE onStart overwrites it so
    // applyTier1IfNeeded has the correct ADR-0012 §Summary invalidation baseline. Only interactive chats
    // carry a `request.id`; headless runs (triggers, sub-agents) have none.
    const priorMessages = input.request.id
      ? await loadChatMessages(input.request.id).catch((err) => {
          // Falls back to the post-overwrite DB read inside applyTier1IfNeeded,
          // which cannot detect edits below the watermark — log the degradation.
          logger.warn(
            { err, chatId: input.request.id },
            "ADR-0012 §Summary invalidation: failed to snapshot prior messages; ADR-0012 §Summary invalidation edit-detection degraded this turn",
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

    // Unattended runs gain a second stop condition alongside the step
    // ceiling: when the model makes no progress (same call → same result,
    // K times) the loop halts before issuing yet another wasteful step.
    // `tripped()` is read after generation to record the run as failed.
    const noProgress: NoProgressDetector | null = params.unattended
      ? createNoProgressDetector()
      : null;

    // `runPrepare` runs `prepare` → `sink.onResolved` → build `modelArgs`, in that
    // order. It is deferred behind a thunk (rather than run inline in `setup`) so
    // the streaming path can open the client UI stream FIRST and invoke it inside
    // the stream's `execute` — that is what lets a mid-prepare model summary write
    // a live in-progress `compact_context` chunk (ADR-0012 §Compaction trace in
    // the timeline). `generate()` (headless) calls it inline with no callback. The
    // prepare-failure path finalizes "failed" and rethrows; both consumers handle
    // the rethrow (stream inside `execute`, generate at the top of its try).
    const runPrepare = async (
      onCompactionSummarizeStart?: (before: CompactionBeforeStats) => void,
    ) => {
      try {
        state.turn = await this.prepare(
          scope,
          input,
          params.origin,
          params.frontendUrl,
          onActivity,
          priorMessages,
          handle.signal,
          onCompactionSummarizeStart,
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

      // Built once per turn. Generation params pass through as-is (including
      // `undefined`): the SDK treats an absent key and an `undefined` value
      // identically, and the streaming path has always passed them this way.
      const modelArgs = {
        // Recovery middleware (ADR-0012 §Recovery): every model call — first call and every
        // tool-loop step, stream and generate alike — gets one trim-and-retry on
        // a provider "context too long" rejection. Always on; not gated by ADR-0012 §Config & kill switch.
        model: withOverflowRecovery(state.turn),
        // Strip the UI-only synthetic compact_context trace parts (ADR-0012 §Compaction trace in the timeline) before
        // sending history to the provider — replaying them surfaces a phantom tool
        // call for a tool the model was never given. Applied here so both the
        // streaming and generate paths (which share modelArgs) are covered.
        messages: await convertToModelMessages(
          stripCompactionTraceParts(state.turn.stream.messages),
        ),
        system: state.turn.stream.system,
        tools: state.turn.stream.tools,
        stopWhen: noProgress
          ? [stepCountIs(state.turn.stream.maxSteps), noProgress.stopCondition]
          : [stepCountIs(state.turn.stream.maxSteps)],
        abortSignal: handle.signal,
        // Tier 2 (ADR-0012 §Tier 2): in-turn compaction before each step when the live window
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

      return { modelArgs };
    };

    return { state, handle, finalize, onStep, noProgress, runPrepare };
  }

  async stream(params: {
    scope: WorkspaceScope;
    input: RunInput;
    sink: RunSink;
    options: StreamOptions;
  }): Promise<Response> {
    const { input, options } = params;
    const { state, handle, finalize, onStep, runPrepare } = await this.setup({
      scope: params.scope,
      input,
      sink: params.sink,
      origin: options.origin,
      frontendUrl: options.frontendUrl,
      timeouts: options.timeouts,
    });

    const startedAt = new Date().toISOString();
    let firstTokenAt: string | undefined;
    // Set when the ADR-0012 §Context-usage ring / §Per-message stats are first emitted (messageMetadata `finish`), so
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

    // Live compaction trace (ADR-0012 §Compaction trace in the timeline): a model
    // summary that begins mid-prepare writes an in-progress `compact_context`
    // chunk; the terminal chunk follows once prepare returns. `ccToolCallId` is
    // set iff the in-progress chunk was written — {@link finalizeCompactionTrace}
    // then guarantees a matching terminal chunk so the badge never hangs.
    const ccIdGen = createIdGenerator({ prefix: "cc", size: 12 });
    let ccToolCallId: string | undefined;

    // Open the client UI stream BEFORE prepare, so a mid-prepare summarize can
    // write the in-progress chunk into it. `execute` runs prepare, resolves the
    // trace, then merges the model stream. The message must have exactly ONE
    // `start`: when a compaction summary fires mid-prepare the callback writes it
    // (before the in-progress chunk) and the merged model stream suppresses its
    // own (`sendStart:false`); otherwise the merged stream provides the sole
    // start. Either way the outer `generateId` is injected into that start, so
    // the message id is stable from its first client-visible chunk (no re-key
    // flicker).
    const uiStream = createUIMessageStream<PlatypusUIMessage>({
      originalMessages: input.messages,
      generateId: createIdGenerator({ prefix: "msg", size: 16 }),
      onError: (error) => formatStreamError(error),
      execute: async ({ writer }) => {
        let modelArgs;
        try {
          ({ modelArgs } = await runPrepare((before) => {
            if (ccToolCallId) return; // one-shot (defensive)
            ccToolCallId = ccIdGen();
            // Open the assistant message BEFORE the in-progress chunk so it
            // carries a stable message id from its first client-visible chunk.
            // Without this, the in-progress part is the stream's first chunk and
            // no `start` precedes it — the merged model stream's `start` lands
            // ~1s later (after summarize), and only then does the client learn
            // the real message id. In that window the client renders the badge
            // under a locally-generated id, then re-pushes it under the server
            // id when `start` arrives — the badge visibly disappears and
            // reappears as Completed (the reported flicker). `handleUIMessage
            // StreamFinish` injects the outer `generateId` into this start; the
            // merged model stream below suppresses its own `start` so this stays
            // the single message-start.
            writer.write({ type: "start" });
            writer.write({
              type: "tool-input-available",
              toolCallId: ccToolCallId,
              toolName: COMPACT_CONTEXT_TOOL_NAME,
              title: "Context compaction",
              input: {
                tokensBefore: before.tokensBefore,
                messagesBefore: before.messagesBefore,
              },
            });
          }));
        } catch {
          // runPrepare already finalized "failed"; surface a terminal error chunk
          // so an in-progress compaction badge flips to Error instead of hanging.
          // The snapshot drain's finally is a no-op (already terminated).
          if (ccToolCallId) {
            writer.write({
              type: "tool-output-error",
              toolCallId: ccToolCallId,
              errorText: "Context compaction failed.",
            });
            // Balance the manual `start` (written when the spinner fired) with a
            // terminal `finish` so the streaming message closes as a matched
            // start/finish pair. On this path the merged model stream — which
            // normally owns the finish — never runs, so without this the client
            // sees a start it can never pair, leaving the message mid-stream.
            writer.write({ type: "finish", finishReason: "error" });
          }
          return;
        }

        logger.debug(
          { systemPrompt: modelArgs.system },
          "System prompt for chat",
        );

        // ALWAYS resolve the in-progress badge (ADR-0012 §Compaction trace in the
        // timeline): present trace → Done + after-stats; spinner fired but no
        // trace (CAS race / swallowed summarize throw) → degraded Done.
        finalizeCompactionTrace(
          writer,
          ccToolCallId,
          state.turn?.compactionTrace,
        );

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

        writer.merge(
          result.toUIMessageStream<PlatypusUIMessage>({
            // Emit the ADR-0012 §Context-usage ring / §Per-message stats with the `finish` event so the client gets them on
            // the final stream chunk — the (i) stats action then appears the instant
            // the answer completes, not a DB-refetch round-trip later. `start` carries
            // only agentId (timing/usage don't exist yet). The post-stream stamp in
            // the finally still writes them to the persisted message for reload.
            // NB: no originalMessages/generateMessageId here — the outer stream
            // owns message identity and the start/finish pair.
            //
            // Suppress this stream's own `start` when the in-progress compaction
            // chunk already opened the message (ccToolCallId set) — a second
            // `start` would re-key the streaming message on the client and make
            // the compaction badge flicker. When no compaction fired, this is the
            // message's only `start`, so let it through.
            sendStart: ccToolCallId === undefined,
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
          }),
        );
      },
    });

    // Tee the UI stream. The response body consumes one branch; we drain the
    // other server-side so a disconnected client (cancelling the response
    // branch) doesn't propagate back to the source. The source keeps pulling as
    // long as the snapshot branch is being read.
    const [forResponse, forSnapshot] = uiStream.tee();

    // Read the snapshot branch as message snapshots and keep `state.messages`
    // up to date. ChatSink's FlushScheduler then writes the in-progress
    // assistant message to the DB on each onProgress bump, so a user who
    // reconnects mid-run sees the partial answer (not just their own
    // input message).
    //
    // finalize is called here (not in toUIMessageStream's onFinish) so that
    // state.messages reflects the fully-drained stream — including the
    // ADR-0012 §Context-usage ring / §Per-message stats applied below — before
    // the sink persists it.
    // An error chunk (model/tool failure surfaced via formatStreamError) or
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
          // not abort — record the run as failed rather than succeeded.
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
    // Headless runs are unattended → enable no-progress detection.
    const { state, handle, finalize, onStep, noProgress, runPrepare } =
      await this.setup({
        scope: params.scope,
        input,
        sink: params.sink,
        frontendUrl: options.frontendUrl,
        timeouts: options.timeouts,
        unattended: true,
      });

    // Headless: no live stream, so no in-progress compaction chunk — run prepare
    // inline. A prepare failure rethrows here (runPrepare already finalized
    // "failed"), matching the pre-refactor behaviour where setup threw.
    const { modelArgs } = await runPrepare();

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
 * Wraps the turn's model with the context-overflow recovery middleware (ADR-0012 §Recovery): every model call — first call and every tool-loop step, stream and
 * generate alike — gets one trim-and-retry on a provider "context too long"
 * rejection. Always on; the ADR-0012 §Config & kill switch does not gate it.
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
  // Reaching here means recovery (ADR-0012 §Recovery) could not salvage the turn:
  // either the trimmed retry was still rejected, or there was nothing left to
  // trim (m1) / the trim itself failed — so we do NOT claim a trim definitely ran
  // (n6). Surface the actionable dead end.
  if (isContextOverflowError(error)) {
    return "Conversation too large for the model's context window — start a new chat or reduce attachments.";
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
