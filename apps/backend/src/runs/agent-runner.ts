import {
  convertToModelMessages,
  createIdGenerator,
  createUIMessageStreamResponse,
} from "ai";
import type { ModelMessage } from "ai";
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
import { driveChat, driveOnce } from "./drive.ts";
import { withStreamKeepalive } from "./stream-keepalive.ts";
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
      memorySnapshot: input.memorySnapshot,
      memoriesReferenceDate: input.memoriesReferenceDate,
      includeMemories: input.includeMemories,
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
  }): Promise<{
    state: RunState;
    run: ReturnType<typeof startRun>;
    /** The resolved turn. Returned in its own right so a caller reads the plan
     *  from here rather than re-narrowing `state.turn`, which stays optional
     *  for the terminal callback that may run before it is assigned. */
    turn: ChatTurn;
    modelMessages: ModelMessage[];
    /** How long this setup — Turn resolution (`CONTEXT.md`) — took, in whole
     *  milliseconds. Surfaced to Users as "Preparation" once stamped onto the
     *  streamed message (issue #354). */
    prepDurationMs: number;
  }> {
    const { scope, input, sink } = params;
    const prepStartMs = Date.now();

    // File gate (issue #328): reject a turn carrying a file the target model
    // can't handle BEFORE the sink persists anything, so a bad attachment can
    // never brick the chat. Runs only when the turn has file parts; throws
    // `FileValidationError`, which the central `onError` (ADR-0010) maps to a
    // 400.
    await validateTurnAttachments({
      request: input.request,
      messages: input.messages,
      orgId: scope.orgId,
      workspaceId: scope.workspaceId,
    });

    const state: RunState = {
      messages: input.messages,
    };

    // Claim the run BEFORE the sink writes anything (issue #648). A second
    // submission for a Chat that already has a live run reaches here with the
    // same runId — a Chat run's id is the chat id — and `startRun` rejects it
    // with a `ConflictError` the central handler answers 409 (ADR-0010). Run
    // the other way round and the duplicate's start hook overwrites the live
    // run's persisted messages with its own history first, then fails: the
    // client gets an error AND the run it interrupted loses its state.
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

    // Registered now, so a start hook that throws releases the claim rather
    // than leaving the runId held by a run that never began — which, with the
    // claim taken first, would lock the Chat out of every later turn.
    try {
      await sink.onStart({
        runId: input.runId,
        messages: input.messages,
        memorySnapshot: input.memorySnapshot,
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error({ error, runId: input.runId }, "Run sink onStart failed");
      await run.finish("failed", err);
      throw err;
    }

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

    const turn = state.turn;
    const plan: ResolvedRunPlan = { resolved: turn.resolved };
    await sink.onResolved({ runId: input.runId, plan });

    // The conversation is converted once, here, and handed to whichever drive
    // the caller picks — `stream` for an HTTP client, `generate` for a headless
    // run. The drives own the model call and the terminal decision from there.
    const modelMessages = await convertToModelMessages(turn.stream.messages);

    return {
      state,
      run,
      turn,
      modelMessages,
      prepDurationMs: Date.now() - prepStartMs,
    };
  }

  async stream(params: {
    scope: WorkspaceScope;
    input: RunInput;
    sink: RunSink;
    options: StreamOptions;
  }): Promise<Response> {
    const { input, options } = params;
    const { state, run, turn, modelMessages, prepDurationMs } =
      await this.setup({
        scope: params.scope,
        input,
        sink: params.sink,
        origin: options.origin,
        frontendUrl: options.frontendUrl,
        timeouts: options.timeouts,
      });

    logger.debug(
      { systemPrompt: turn.stream.system },
      "System prompt for chat",
    );

    // How long each locally-executed tool took, keyed by `toolCallId`. The SDK
    // has already measured it; the drive holds it long enough to stamp it onto
    // the finished messages (see `applyToolDurations`). Provider-executed tools
    // never reach this callback and so carry no duration.
    const toolDurations = new Map<string, number>();

    // The drive runs the model loop, folds the stream and tees off the client
    // branch; this runner keeps only the server-side drain (which keeps
    // `state.messages` fresh for the sink's mid-run flush) and the response.
    // Terminal status, the output-ceiling cutoff and the stop conditions are
    // all decided inside `runs/drive.ts`.
    const drive = driveChat({
      plan: turn.stream,
      modelMessages,
      run,
      originalMessages: input.messages,
      agentId: turn.resolved.agentId,
      searchUnavailable: turn.searchUnavailable,
      prepDurationMs,
      generateMessageId: createIdGenerator({ prefix: "msg", size: 16 }),
      toolDurations,
      onToolExecutionEnd: ({ toolCall, toolExecutionMs }) => {
        toolDurations.set(toolCall.toolCallId, toolExecutionMs);
      },
      // The terminal finish (with tool durations applied) is what the sink's
      // final write must observe.
      onFinal: (messages) => {
        state.messages = messages;
      },
    });

    // Consume the snapshot branch server-side. The response body drives one
    // branch; we drain the other so a disconnected client (cancelling the
    // response branch) doesn't propagate back to the source — the run keeps
    // pulling as long as the snapshot branch is being read.
    void (async () => {
      try {
        for await (const message of drive.snapshots) {
          // Keep `state.messages` current so ChatSink's FlushScheduler writes
          // the in-progress assistant message on each onProgress bump — a user
          // who reconnects mid-run sees the partial answer. The drive stops
          // yielding after the final handover, so this never overwrites the
          // folded final with a duration-less snapshot.
          state.messages = [...input.messages, message];
        }
      } catch (err) {
        logger.error(
          { err, runId: input.runId },
          "Server-side UI stream consumer error",
        );
      } finally {
        await drive.done;
      }
    })().catch((err) =>
      logger.error({ err, runId: input.runId }, "Chat drive background error"),
    );

    // Wrapped past the tee, so the heartbeat reaches the client and not the
    // server-side drain above (issue #648). The no-buffering header a reverse
    // proxy needs is already on the response the SDK builds; `stream-keepalive`
    // carries it through, and its test pins that it is still there.
    return withStreamKeepalive(
      createUIMessageStreamResponse({ stream: drive.response }),
    );
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
    const { run, turn, modelMessages } = await this.setup({
      scope: params.scope,
      input,
      sink: params.sink,
      frontendUrl: options.frontendUrl,
      timeouts: options.timeouts,
    });

    // The drive computes the stats, records the output-ceiling cutoff, decides
    // the terminal status and finishes the run — this entry point only returns.
    const { text, stats } = await driveOnce({
      plan: turn.stream,
      modelMessages,
      run,
    });

    return { text, stats };
  }
}

/** Singleton runner — services and routes share one instance. */
export const agentRunner = new AgentRunner();
