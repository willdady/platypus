import {
  convertToModelMessages,
  createIdGenerator,
  createUIMessageStreamResponse,
} from "ai";
import type { InferUIMessageChunk, ModelMessage } from "ai";
import {
  drizzleChatTurnQueries,
  prepareChatTurn,
  validateTurnAttachments,
  type ChatTurn,
} from "../services/chat-execution.ts";
import type { ToolActivityEvent } from "../services/tool-activity.ts";
import { ConflictError } from "../errors.ts";
import { logger } from "../logger.ts";
import { convertDataPart } from "../sandbox/upload-note.ts";
import { actorUserId, type WorkspaceScope } from "../scope.ts";
import type { PlatypusUIMessage } from "../types.ts";
import type { RunTimeouts } from "./run-registry.ts";
import { startRun, type RunLifecycle } from "./run-lifecycle.ts";
import { driveChat, driveOnce } from "./drive.ts";
import { RunEventRecorder } from "./run-events.ts";
import { withStreamKeepalive } from "./stream-keepalive.ts";
import { hasOutput, holdFirstOutput } from "./first-output.ts";
import type {
  ParentRunContext,
  ResolvedRunPlan,
  RunInput,
  RunSink,
  RunStats,
  TurnFacts,
} from "./types.ts";

export type StreamOptions = {
  origin: string;
  frontendUrl: string;
  timeouts?: RunTimeouts;
};

export type GenerateOptions = {
  frontendUrl: string;
  timeouts?: RunTimeouts;
};

export type GenerateResult = {
  text: string;
  stats: RunStats;
};

const userFromScope = (scope: WorkspaceScope): { id: string; name: string } => {
  const p = scope.principal;
  if (p.kind === "user") return { id: p.userId, name: p.name };
  if (p.kind === "trigger" || p.kind === "a2a") {
    return { id: p.onBehalfOfUserId, name: p.name };
  }
  return { id: actorUserId(scope.principal), name: "Sub-agent" };
};

type RunState = {
  messages: PlatypusUIMessage[];
  finalText?: string;
};

const foldSnapshot = (
  original: PlatypusUIMessage[],
  message: PlatypusUIMessage,
): PlatypusUIMessage[] =>
  original.at(-1)?.id === message.id
    ? [...original.slice(0, -1), message]
    : [...original, message];

const finishFailedOnThrow = async <T>(
  run: RunLifecycle,
  message: string,
  work: () => T | Promise<T>,
): Promise<T> => {
  try {
    return await work();
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    if (!(err instanceof ConflictError)) {
      logger.error({ error, runId: run.handle.runId }, message);
    }
    if (run.handle.signal.aborted) {
      const { status, error: stopped } = run.statusFromSignal();
      await run.finish(status, stopped);
    } else {
      await run.finish("failed", err);
    }
    throw err;
  }
};

export class AgentRunner {
  private async prepare(
    scope: WorkspaceScope,
    input: RunInput,
    origin: string | undefined,
    frontendUrl: string,
    timeouts: RunTimeouts | undefined,
    onActivity: (event: ToolActivityEvent) => void,
    signal: AbortSignal,
    setDelegateUsage: ParentRunContext["setDelegateUsage"],
    fallbackAllowed: boolean,
  ): Promise<ChatTurn> {
    const { runId, ...turnRequest } = input;
    return prepareChatTurn(
      {
        ...turnRequest,
        orgId: scope.orgId,
        workspaceId: scope.workspaceId,
        user: userFromScope(scope),
        sessionId: runId,
        origin,
        frontendUrl,
        runMode: scope.principal.kind === "user" ? "interactive" : "headless",
        fallbackAllowed,
        a2aClientName:
          scope.principal.kind === "a2a" ? scope.principal.name : undefined,
        onActivity,
        run: { runId, scope, timeouts, setDelegateUsage },
        signal,
      },
      drizzleChatTurnQueries,
    );
  }

  private async setup(params: {
    scope: WorkspaceScope;
    input: RunInput;
    sink: RunSink;
    origin?: string;
    frontendUrl: string;
    timeouts?: RunTimeouts;
    events?: RunEventRecorder;
    fallbackAllowed?: boolean;
  }): Promise<{
    state: RunState;
    run: ReturnType<typeof startRun>;
    turn: ChatTurn;
    modelMessages: ModelMessage[];
    facts: TurnFacts;
  }> {
    const { scope, input, sink } = params;
    const prepStartMs = Date.now();

    await validateTurnAttachments(
      {
        request: input.request,
        messages: input.messages,
        orgId: scope.orgId,
        workspaceId: scope.workspaceId,
        sessionId: input.runId,
      },
      drizzleChatTurnQueries,
    );

    const state: RunState = {
      messages: input.messages,
    };

    const run = startRun({
      runId: input.runId,
      timeouts: params.timeouts,
      onTerminate: async ({ status, error, stats }) => {
        try {
          await sink.onFinish({
            runId: input.runId,
            status,
            messages: state.messages,
            stats,
            error,
            finalText: state.finalText,
          });
        } catch (err) {
          logger.error({ err, runId: input.runId }, "Error in onFinish");
        }
      },
      onStepProgress: (stats) => {
        void sink
          .onProgress({ runId: input.runId, messages: state.messages, stats })
          .catch((err) =>
            logger.error({ err, runId: input.runId }, "Error in onProgress"),
          );
      },
    });

    await finishFailedOnThrow(run, "Run sink onStart failed", () =>
      sink.onStart({
        runId: input.runId,
        messages: input.messages,
        memorySnapshot: input.memorySnapshot,
        events: params.events,
      }),
    );

    const turn = await finishFailedOnThrow(
      run,
      "Run prepare failed before model invocation",
      () =>
        this.prepare(
          scope,
          input,
          params.origin,
          params.frontendUrl,
          params.timeouts,
          run.onActivity,
          run.handle.signal,
          run.setDelegateUsage,
          params.fallbackAllowed ?? false,
        ),
    );

    if (!(await run.adoptOrDispose(turn.dispose))) {
      const { error } = run.statusFromSignal();
      const err =
        error ?? new Error(`Run '${input.runId}' ended before it could start`);
      logger.error(
        { err, runId: input.runId },
        "Run terminated while its turn was still resolving; not invoking the model",
      );
      throw err;
    }

    const modelMessages = await finishFailedOnThrow(
      run,
      "Run setup failed after adopting its turn",
      async () => {
        const plan: ResolvedRunPlan = {
          resolved: turn.resolved,
          resolvedModelId: turn.resolvedModelId,
          unloadedToolSets: turn.unloadedToolSets,
          contextWindow: turn.stream.contextWindow,
          readOnlyToolNames: turn.stream.readOnlyToolNames,
        };
        await sink.onResolved({ runId: input.runId, plan });

        return convertToModelMessages(turn.stream.messages, {
          ignoreIncompleteToolCalls: true,
          convertDataPart,
        });
      },
    );

    return {
      state,
      run,
      turn,
      modelMessages,
      facts: {
        agentId: turn.resolved.agentId,
        searchUnavailable: turn.searchUnavailable,
        prepDurationMs: Date.now() - prepStartMs,
        summaryId: turn.stream.summaryId,
      },
    };
  }

  async stream(params: {
    scope: WorkspaceScope;
    input: RunInput;
    sink: RunSink;
    options: StreamOptions;
  }): Promise<Response> {
    const { input, options } = params;
    const { state, run, turn, modelMessages, facts } = await this.setup({
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

    const toolDurations = new Map<string, number>();

    const drive = await finishFailedOnThrow(
      run,
      "Run failed before its drive took over",
      () =>
        driveChat({
          plan: turn.stream,
          modelMessages,
          run,
          originalMessages: input.messages,
          facts,
          generateMessageId: createIdGenerator({ prefix: "msg", size: 16 }),
          toolDurations,
          onToolExecutionEnd: ({ toolCall, toolExecutionMs }) => {
            toolDurations.set(toolCall.toolCallId, toolExecutionMs);
          },
          onFinal: (messages) => {
            state.messages = messages;
          },
        }),
    );

    // why: must settle, never reject; the client stream's first output waits on it
    const { promise: saved, resolve: outputSaved } =
      Promise.withResolvers<void>();
    let outputSeen = false;

    // why: drained server-side so a disconnected client can't stop the run (ADR-0049)
    void (async () => {
      try {
        for await (const message of drive.snapshots) {
          state.messages = foldSnapshot(input.messages, message);
          if (!outputSeen && hasOutput(message)) {
            outputSeen = true;
            const messages = state.messages;
            void Promise.resolve()
              .then(() =>
                params.sink.onOutput?.({ runId: input.runId, messages }),
              )
              .catch((err) =>
                logger.error({ err, runId: input.runId }, "Error in onOutput"),
              )
              .finally(outputSaved);
          }
        }
      } catch (err) {
        logger.error(
          { err, runId: input.runId },
          "Server-side UI stream consumer error",
        );
      } finally {
        outputSaved();
        await drive.done;
      }
    })().catch((err) =>
      logger.error({ err, runId: input.runId }, "Chat drive background error"),
    );

    // why: client branch only; the persisted reply must never carry the wait's status row
    const clientStream = turn.summaryBackstop
      ? drive.response.pipeThrough(withSummarisingStatus())
      : drive.response;

    // why: wrapped past the tee, so the heartbeat reaches the client, not the drain
    return withStreamKeepalive(
      createUIMessageStreamResponse({
        stream: clientStream.pipeThrough(holdFirstOutput(saved)),
      }),
    );
  }

  async generate(params: {
    scope: WorkspaceScope;
    input: RunInput;
    sink: RunSink;
    options: GenerateOptions;
  }): Promise<GenerateResult> {
    const { input } = params;
    const options = params.options;
    const events = new RunEventRecorder({ runId: input.runId });
    const { state, run, turn, modelMessages, facts } = await this.setup({
      scope: params.scope,
      input,
      sink: params.sink,
      frontendUrl: options.frontendUrl,
      timeouts: options.timeouts,
      events,
      fallbackAllowed: true,
    });

    const { text, stats } = await driveOnce({
      plan: turn.stream,
      modelMessages,
      run,
      agentId: facts.agentId,
      events,
      ...(turn.fallback ? { fallback: turn.fallback } : {}),
      onFinal: (finalText) => {
        state.finalText = finalText;
      },
      onSnapshot: (message) => {
        state.messages = foldSnapshot(input.messages, message);
      },
    });

    return { text, stats };
  }
}

export const TRANSCRIPT_SUMMARY_STATUS_TEXT = "Summarising earlier messages…";

const withSummarisingStatus = (): TransformStream<
  InferUIMessageChunk<PlatypusUIMessage>,
  InferUIMessageChunk<PlatypusUIMessage>
> =>
  new TransformStream({
    start(controller) {
      controller.enqueue({
        type: "data-transcript-summary-status",
        data: { text: TRANSCRIPT_SUMMARY_STATUS_TEXT },
      });
    },
    transform(chunk, controller) {
      controller.enqueue(chunk);
    },
  });

export const agentRunner = new AgentRunner();
