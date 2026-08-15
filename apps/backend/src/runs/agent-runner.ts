import {
  convertToModelMessages,
  createIdGenerator,
  createUIMessageStreamResponse,
  generateText,
  readUIMessageStream,
  streamText,
} from "ai";
import { formatStreamError, isTruncatedByTokenLimit } from "./stream-error.ts";
import { createMessageMetadata } from "./message-metadata.ts";
import { applyToolDurations } from "./tool-durations.ts";
import {
  prepareChatTurn,
  validateTurnAttachments,
  type ChatTurn,
} from "../services/chat-execution.ts";
import type { ToolActivityEvent } from "../services/tool-activity.ts";
import { logger } from "../logger.ts";
import { actorUserId, type WorkspaceScope } from "../scope.ts";
import type { PlatypusUIMessage } from "../types.ts";
import { runRegistry, type RunTimeouts } from "./run-registry.ts";
import { startRun } from "./run-lifecycle.ts";
import { buildModelInvocation } from "./run-plan.ts";
import { computeStats } from "./run-stats.ts";
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
} from "./types.ts";

export type StreamOptions = {
  origin: string;
  frontendUrl?: string;
  /**
   * Override per-step / per-run timeouts for this run. The HTTP request
   * abort signal is intentionally NOT accepted — Chat runs continue to
   * completion regardless of the client connection (see issue #113).
   */
  timeouts?: RunTimeouts;
};

export type GenerateOptions = {
  frontendUrl?: string;
  timeouts?: RunTimeouts;
};

export type GenerateResult = {
  text: string;
  stats: RunStats;
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

/** Mutable per-run state shared by `setup`, the timeout handler, and the
 *  consumer-shaped entry point. A background timer (the timeout) and the
 *  foreground model call both read/write it, so it lives in one object both
 *  can reach. */
type RunState = {
  turn?: ChatTurn;
  messages: PlatypusUIMessage[];
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
 * A delegated (sub-agent) run is not driven from here: the delegate tool owns
 * its own turn, already resolved by the parent's `prepareChatTurn`. It shares
 * the lifecycle rather than the entry point — see `runs/run-lifecycle.ts`.
 */
export class AgentRunner {
  private async prepare(
    scope: WorkspaceScope,
    input: RunInput,
    origin: string | undefined,
    frontendUrl: string | undefined,
    timeouts: RunTimeouts | undefined,
    onActivity: (event: ToolActivityEvent) => void,
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
      // Sub-agent delegate tools built for this turn register their own runs
      // as children of this one, so they need to know whose child they are and
      // what bounds this run was started under.
      run: { runId: input.runId, scope, timeouts },
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
   * Shared run scaffolding: the sink lifecycle (`onStart` → `onResolved`) laid
   * over the run lifecycle (registry, timeouts, statistics, once-only
   * termination). Both `stream` and `generate` build on this; only the model
   * invocation and the consumer-shaped return value differ.
   *
   * The terminal callback lives here but reads `state`, which the caller keeps
   * writing (the streamed messages) after `setup` returns — so a timeout firing
   * mid-stream still persists the partial answer.
   */
  private async setup(params: {
    scope: WorkspaceScope;
    input: RunInput;
    sink: RunSink;
    origin?: string;
    frontendUrl?: string;
    timeouts?: RunTimeouts;
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
      messages: input.messages,
    };

    const run = startRun({
      runId: input.runId,
      timeouts: params.timeouts,
      onTerminate: async ({ status, error, stats }) => {
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
            stats,
            error,
          });
        } catch (err) {
          logger.error({ err, runId: input.runId }, "Error in onFinish");
        }
      },
      // Sink decides write cadence (FlushScheduler in ChatSink).
      onStepProgress: (stats) => {
        void sink
          .onProgress({ runId: input.runId, messages: state.messages, stats })
          .catch((err) =>
            logger.error({ err, runId: input.runId }, "Error in onProgress"),
          );
      },
    });

    try {
      state.turn = await this.prepare(
        scope,
        input,
        params.origin,
        params.frontendUrl,
        params.timeouts,
        run.onActivity,
      );
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error(
        { error, runId: input.runId },
        "Run prepare failed before model invocation",
      );
      await run.finish("failed", err);
      throw err;
    }

    const plan: ResolvedRunPlan = { resolved: state.turn.resolved };
    await sink.onResolved({ runId: input.runId, plan });

    // Unattended runs gain a second stop condition alongside the step
    // ceiling: when the model makes no progress (same call → same result,
    // K times) the loop halts before issuing yet another wasteful step.
    // `tripped()` is read after generation to record the run as failed.
    const noProgress: NoProgressDetector | null = params.unattended
      ? createNoProgressDetector()
      : null;

    // Built once and shared by both invocations, by the same assembly a
    // delegated run uses.
    const modelArgs = {
      ...buildModelInvocation(state.turn.stream, {
        abortSignal: run.handle.signal,
        extraStopCondition: noProgress?.stopCondition,
      }),
      messages: await convertToModelMessages(state.turn.stream.messages),
    };

    return { state, run, modelArgs, noProgress };
  }

  async stream(params: {
    scope: WorkspaceScope;
    input: RunInput;
    sink: RunSink;
    options: StreamOptions;
  }): Promise<Response> {
    const { input, options } = params;
    const { state, run, modelArgs } = await this.setup({
      scope: params.scope,
      input,
      sink: params.sink,
      origin: options.origin,
      frontendUrl: options.frontendUrl,
      timeouts: options.timeouts,
    });

    logger.debug({ systemPrompt: modelArgs.system }, "System prompt for chat");

    // How long each locally-executed tool took, keyed by `toolCallId`. The SDK
    // has already measured it; we only hold onto it long enough to stamp it onto
    // the outgoing chunks and onto the finished messages (see
    // `injectToolDurations` and `applyToolDurations`). Provider-executed tools
    // never reach this callback and so carry no duration.
    const toolDurations = new Map<string, number>();

    // Whether `onFinish` has handed over the finished messages. The two branches
    // of the tee below race: the source can finish while the snapshot branch
    // still has chunks buffered, and disposing the turn is real I/O that gives
    // that branch time to drain. A snapshot arriving after the handover is
    // strictly worse than what it would overwrite — same content, minus the
    // tool durations — so the snapshot stops writing once this is set.
    let finalMessagesReceived = false;

    const result = streamText({
      ...modelArgs,
      onStepFinish: (step) => run.onStep(step),
      onToolExecutionEnd: ({ toolCall, toolExecutionMs }) => {
        toolDurations.set(toolCall.toolCallId, toolExecutionMs);
      },
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
      messageMetadata: createMessageMetadata(
        state.turn?.resolved.agentId,
        toolDurations,
      ),
      onError: (error) => formatStreamError(error),
      onFinish: async ({ messages: finalMessages }) => {
        // Stamped onto the parts here as well as travelling out as metadata:
        // this is the per-part form the persisted messages use, and the one a
        // reload reads. Setting the flag first closes the snapshot branch's
        // window to overwrite this, so the sink's terminal write observes it.
        finalMessagesReceived = true;
        state.messages = applyToolDurations(finalMessages, toolDurations);
        const { status, error } = run.statusFromSignal();
        await run.finish(status, error);
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
          // Keep draining after the handover — the branch is still teed to a
          // live source — but stop writing; `onFinish` has the better copy.
          if (finalMessagesReceived) continue;
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
    const { run, modelArgs, noProgress } = await this.setup({
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
        onStepFinish: (step) => run.onStep(step),
      });

      const stats = computeStats(result as Parameters<typeof computeStats>[0]);
      // The terminal finish only, as on the streamed path: a step inside a tool
      // loop can end at the ceiling and the run still recover. Set before
      // `finish`, which is what carries the run's stats to `sink.onFinish` —
      // the sink's record is the only channel an unattended run has.
      if (isTruncatedByTokenLimit(result.finishReason)) {
        stats.truncatedByTokenLimit = true;
      }
      run.setStats(stats);

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
            // Carried here too: this path returns before the completion log
            // below, so without it a no-progress run records neither reason.
            finishReason: result.finishReason,
            rawFinishReason: result.rawFinishReason,
            stats,
          },
          "Run aborted: no progress",
        );
        await run.finish("failed", err);
        return { text: result.text, stats };
      }

      // Nobody is watching an unattended run, so this log is the only record
      // of how it ended. Carry both reasons for the same reason `onStep` does.
      logger.info(
        {
          runId: input.runId,
          duration: Date.now() - startTime,
          responseLength: result.text.length,
          finishReason: result.finishReason,
          rawFinishReason: result.rawFinishReason,
          stats,
        },
        "Run generate completed",
      );

      await run.finish("succeeded");
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
      // A cancelled run is recorded as cancelled; a timed-out one stays a
      // failure, and so does anything the model call threw on its own.
      const aborted = run.statusFromSignal();
      await run.finish(
        aborted.status === "cancelled" ? "cancelled" : "failed",
        err,
      );
      throw err;
    }
  }
}

/** Singleton runner — services and routes share one instance. */
export const agentRunner = new AgentRunner();
