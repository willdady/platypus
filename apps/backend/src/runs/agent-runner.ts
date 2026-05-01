import {
  APICallError,
  LoadAPIKeyError,
  convertToModelMessages,
  createIdGenerator,
  generateText,
  stepCountIs,
  streamText,
  type LanguageModel,
} from "ai";
import {
  prepareChatTurn,
  type ChatSubmitData,
  type ChatTurn,
} from "../services/chat-execution.ts";
import { logger } from "../logger.ts";
import { actorUserId, type WorkspaceScope } from "../scope.ts";
import type { PlatypusUIMessage } from "../types.ts";
import type { ResolvedRunPlan, RunInput, RunSink, RunStats } from "./types.ts";

export type StreamOptions = {
  abortSignal?: AbortSignal;
  origin: string;
  frontendUrl?: string;
};

export type GenerateOptions = {
  abortSignal?: AbortSignal;
  /**
   * Required by `prepareChatTurn` for file-URL inlining. Headless paths
   * (triggers, sub-agents) have no storage:// URLs to rewrite, so any
   * placeholder works. Defaults to a non-resolvable internal URL.
   */
  origin?: string;
  frontendUrl?: string;
};

export type GenerateResult = {
  text: string;
  stats: RunStats;
};

/**
 * Translates a discriminated `RunInput.source` and overrides into the flat
 * `ChatSubmitData` shape consumed by `prepareChatTurn`.
 */
const toChatSubmitData = (input: RunInput): ChatSubmitData => {
  const overrides = input.overrides ?? {};
  if (input.source.kind === "agent") {
    return { agentId: input.source.agentId, ...overrides };
  }
  return {
    providerId: input.source.providerId,
    modelId: input.source.modelId,
    systemPrompt: input.source.systemPrompt,
    ...overrides,
  };
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
 * Orchestrates an end-to-end agent run.
 *
 * The runner wraps `prepareChatTurn` with a `RunSink` lifecycle and offers
 * two consumer-shaped entry points: `stream()` for HTTP streaming clients
 * and `generate()` for headless callers (triggers, sub-agents).
 *
 * Out of scope (later PRs):
 * - Out-of-band `cancel(runId)` and run registry (PR #3)
 * - Decoupling chat from request abort signal (PR #3)
 * - Periodic time-based `onProgress` flushing (PR #3)
 * - Sub-agent runs as AgentRunner consumers (PR #4)
 */
export class AgentRunner {
  private async prepare(
    scope: WorkspaceScope,
    input: RunInput,
    origin: string,
    frontendUrl?: string,
  ): Promise<ChatTurn> {
    return prepareChatTurn({
      orgId: scope.orgId,
      workspaceId: scope.workspaceId,
      user: userFromScope(scope),
      request: toChatSubmitData(input),
      messages: input.messages,
      origin,
      frontendUrl,
    });
  }

  async stream(params: {
    scope: WorkspaceScope;
    input: RunInput;
    sink: RunSink;
    options: StreamOptions;
  }): Promise<Response> {
    const { scope, input, sink, options } = params;
    await sink.onStart({ runId: input.runId });

    let turn: ChatTurn;
    try {
      turn = await this.prepare(
        scope,
        input,
        options.origin,
        options.frontendUrl,
      );
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      await sink.onFinish({
        runId: input.runId,
        status: "failed",
        messages: [],
        stats: {},
        error: err,
      });
      throw err;
    }

    const plan: ResolvedRunPlan = { resolved: turn.resolved };
    await sink.onResolved({ runId: input.runId, plan });

    if (options.abortSignal) {
      options.abortSignal.addEventListener("abort", () => {
        void turn.dispose();
      });
    }

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
      abortSignal: options.abortSignal,
      temperature: turn.stream.temperature,
      topP: turn.stream.topP,
      topK: turn.stream.topK,
      frequencyPenalty: turn.stream.frequencyPenalty,
      presencePenalty: turn.stream.presencePenalty,
      seed: turn.stream.seed,
    });

    return result.toUIMessageStreamResponse<PlatypusUIMessage>({
      originalMessages: input.messages,
      generateMessageId: createIdGenerator({ prefix: "msg", size: 16 }),
      messageMetadata: () =>
        turn.resolved.agentId ? { agentId: turn.resolved.agentId } : undefined,
      onError: (error) => formatStreamError(error),
      onFinish: async ({ messages: finalMessages }) => {
        try {
          await turn.dispose();
          await sink.onFinish({
            runId: input.runId,
            status: "succeeded",
            messages: finalMessages,
            stats: {},
          });
        } catch (error) {
          logger.error({ error }, "Error in stream onFinish");
        }
      },
    });
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
    const origin = options.origin ?? "http://internal.run";

    await sink.onStart({ runId: input.runId });

    let turn: ChatTurn;
    try {
      turn = await this.prepare(scope, input, origin, options.frontendUrl);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error(
        { error, runId: input.runId },
        "Run prepare failed before model invocation",
      );
      await sink.onFinish({
        runId: input.runId,
        status: "failed",
        messages: [],
        stats: {},
        error: err,
      });
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
      logger.info(
        {
          runId: input.runId,
          duration: Date.now() - startTime,
          responseLength: result.text.length,
          stats,
        },
        "Run generate completed",
      );

      await sink.onFinish({
        runId: input.runId,
        status: "succeeded",
        messages: [],
        stats,
      });
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
      await sink.onFinish({
        runId: input.runId,
        status: "failed",
        messages: [],
        stats: {},
        error: err,
      });
      throw err;
    } finally {
      await turn.dispose();
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
