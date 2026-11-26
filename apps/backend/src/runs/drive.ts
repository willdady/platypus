import {
  createIdGenerator,
  readUIMessageStream,
  streamText,
  toUIMessageStream,
  type InferUIMessageChunk,
  type ModelMessage,
} from "ai";
import { logger } from "../logger.ts";
import type { PlatypusUIMessage } from "../types.ts";
import { createMessageMetadata } from "./message-metadata.ts";
import { isClearableToolName } from "./tool-result-clearing.ts";
import {
  createNoProgressDetector,
  NoProgressError,
  type NoProgressDetector,
} from "./no-progress.ts";
import {
  buildModelInvocation,
  GENERATION_FIELDS,
  pickPlanFields,
  TURN_FIELDS,
  type RunPlan,
} from "./run-plan.ts";
import {
  createOverflowRecovery,
  type OverflowRecovery,
} from "./context-overflow-recovery.ts";
import type { RunLifecycle } from "./run-lifecycle.ts";
import { describeTimeout, TimeoutError } from "./run-registry.ts";
import type { computeStats, RunStep, UsageModel } from "./run-stats.ts";
import { describeSdkError, formatStreamError } from "./stream-error.ts";
import { applyToolDurations } from "./tool-durations.ts";
import {
  FALLBACK_SDK_RETRIES,
  isProviderUnavailableError,
  sanitizeMessagesForFallback,
} from "./fallback.ts";
import {
  eventStatusForRun,
  recordRunEvents,
  recordUiChunk,
  wrapToolsWithRunEvents,
  type RunEventRecorder,
  type RunEventScope,
} from "./run-events.ts";
import type { RunStats, RunStatus, TurnFacts } from "./types.ts";
import type { FallbackTurn } from "./types.ts";
import type { ModelSwitch } from "@platypus/schemas";
import {
  normalizeWebToolMessage,
  normalizeWebToolParts,
} from "./web-tool-normalize.ts";
import { replaySeededParts } from "./replay-seeded-parts.ts";
import { withAgentCausation, withChildCausation } from "../event-causation.ts";

type DriveConversation =
  | { prompt: string; modelMessages?: never }
  | { prompt?: never; modelMessages: ModelMessage[] };

type DriveBase = {
  plan: RunPlan;
  run: RunLifecycle;
};

const conversationArgs = (conversation: DriveConversation) =>
  conversation.prompt !== undefined
    ? { prompt: conversation.prompt }
    : { messages: conversation.modelMessages };

const modelArgs = (
  opts: DriveBase & DriveConversation & { maxRetries?: number },
  noProgress: NoProgressDetector | null,
  overflowRecovery: OverflowRecovery,
) => ({
  ...buildModelInvocation(opts.plan, {
    abortSignal: opts.run.handle.signal,
    extraStopCondition: noProgress?.stopCondition,
    overflowRecovery,
  }),
  ...conversationArgs(opts),
  ...(opts.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : {}),
});

const detectorFor = (unattended: boolean): NoProgressDetector | null =>
  unattended ? createNoProgressDetector() : null;

const planRecording = (plan: RunPlan, scope: RunEventScope | undefined) =>
  scope ? { ...plan, tools: wrapToolsWithRunEvents(plan.tools, scope) } : plan;

// why: the SDK merge keeps a cut-short mark the continued request never set
const withoutCutShortFlags = (
  message: PlatypusUIMessage | undefined,
): PlatypusUIMessage | undefined => {
  if (!message?.metadata) return message;
  const {
    truncatedByTokenLimit: _truncated,
    stoppedAtStepLimit: _stopped,
    ...metadata
  } = message.metadata;
  return { ...message, metadata };
};

export type StreamedDriveResult = {
  status: RunStatus;
  messages?: PlatypusUIMessage[];
  latest?: PlatypusUIMessage;
  failure?: string;
  truncated: boolean;
  stoppedAtStepLimit: boolean;
};

type TerminalDecision = {
  status: RunStatus;
  error?: Error;
  failure?: string;
};

const decideTerminalStatus = (
  run: RunLifecycle,
  opts: {
    failure?: string;
    noProgress: NoProgressDetector | null;
    failOnStreamError: boolean;
    emptyAtOutputCeiling?: boolean;
  },
): TerminalDecision => {
  const trip = opts.noProgress?.tripped() ?? null;
  if (trip) {
    const err = new NoProgressError(trip.toolName, trip.count);
    return { status: "failed", error: err, failure: err.message };
  }

  const { status, error } = run.statusFromSignal();
  if (status === "succeeded" && opts.emptyAtOutputCeiling) {
    const failure =
      "The model hit its output limit before writing an answer. Raise the Provider model's Max output tokens.";
    return { status: "failed", error: new Error(failure), failure };
  }
  if (!opts.failOnStreamError) return { status, error };

  const stoppedShort = run.handle.signal.aborted
    ? run.abortReason()
      ? `Stopped before finishing: ${run.abortReason()}`
      : "Stopped before finishing."
    : undefined;
  const failure = opts.failure ?? stoppedShort;
  if (!failure) return { status, error };

  return status === "succeeded"
    ? { status: "failed", error: new Error(failure), failure }
    : { status, error, failure };
};

export const failBeforeDrive = async (
  run: RunLifecycle,
  failure: string,
): Promise<StreamedDriveResult> => {
  const decision = decideTerminalStatus(run, {
    failure,
    noProgress: null,
    failOnStreamError: true,
  });
  await run.finish(decision.status, decision.error);
  return {
    status: decision.status,
    failure: decision.failure ?? failure,
    truncated: false,
    stoppedAtStepLimit: false,
  };
};

type StreamedBehavior = {
  unattended: boolean;
  failOnStreamError: boolean;
  stopSnapshotsAfterFinal: boolean;
};

export type ChatDriveOptions = DriveBase &
  DriveConversation & {
    originalMessages?: PlatypusUIMessage[];
    facts?: TurnFacts;
    generateMessageId?: () => string;
    toolDurations?: Map<string, number>;
    onStepFinish?: (step: RunStep) => void;
    onToolExecutionEnd?: (ctx: {
      toolCall: { toolCallId: string };
      toolExecutionMs: number;
    }) => void;
    onFinal?: (messages: PlatypusUIMessage[]) => void;
    events?: RunEventScope;
    fallback?: FallbackTurn;
  };

export type DelegateDriveOptions = DriveBase &
  DriveConversation & {
    onStepFinish?: (step: RunStep) => void;
    agentId: string;
    events?: RunEventScope;
    fallback?: FallbackTurn;
  };

type SplitStream = (
  ui: ReadableStream<InferUIMessageChunk<PlatypusUIMessage>>,
) => ReadableStream<InferUIMessageChunk<PlatypusUIMessage>>;

type StreamedCore = {
  snapshots: AsyncIterable<PlatypusUIMessage>;
  done: Promise<StreamedDriveResult>;
};

type ModelLoopOptions = DriveBase &
  DriveConversation &
  Omit<
    ChatDriveOptions,
    "onFinal" | keyof DriveBase | keyof DriveConversation
  > & {
    noProgress: NoProgressDetector | null;
    continued?: PlatypusUIMessage;
    onEnd?: (messages: PlatypusUIMessage[]) => void;
    maxRetries?: number;
  };

type LoopStats = Parameters<typeof computeStats>[0];

type LoopStep = LoopStats["steps"][number] & {
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    inputTokenDetails?: {
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
    };
  };
  response?: { messages?: ModelMessage[] };
};

export type ModelLoopOutcome = {
  failure?: string;
  truncated: boolean;
  stoppedAtStepLimit: boolean;
  text: string;
  finishReason: string | undefined;
  rawFinishReason: string | undefined;
  steps: LoopStep[];
  totalUsage: LoopStats["totalUsage"];
  rejection?: { error: unknown };
  failureError?: unknown;
  stepMessages: ModelMessage[];
  completedSteps: LoopStep[];
};

const withCutoffs = (
  stats: RunStats,
  outcome: Pick<ModelLoopOutcome, "truncated" | "stoppedAtStepLimit">,
): RunStats => ({
  ...stats,
  ...(outcome.truncated ? { truncatedByTokenLimit: true as const } : {}),
  ...(outcome.stoppedAtStepLimit ? { stoppedAtStepLimit: true as const } : {}),
});

type ModelLoop = {
  chunks: ReadableStream<InferUIMessageChunk<PlatypusUIMessage>>;
  reportFailure: (error: unknown) => void;
  outcome: () => Promise<ModelLoopOutcome>;
};

const modelLoop = ({
  plan: givenPlan,
  run,
  noProgress,
  events,
  facts,
  toolDurations,
  generateMessageId,
  originalMessages,
  continued,
  onStepFinish,
  onToolExecutionEnd,
  onEnd,
  maxRetries,
  ...conversation
}: ModelLoopOptions): ModelLoop => {
  run.setUsageModel(givenPlan.usageModel);
  const plan = planRecording(givenPlan, events);
  const overflowRecovery = createOverflowRecovery();
  let failure: string | undefined;
  let failureError: unknown;
  const recordFailure = (error: unknown): void => {
    if (failure === undefined) failureError = error;
    failure ??= describeSdkError(error);
  };
  const stepMessages: ModelMessage[] = [];
  const completedSteps: LoopStep[] = [];
  let truncated = false;
  let stoppedAtStepLimit = false;

  // why: stamped just before streamText; any later undercounts the model time
  const driveStartMs = Date.now();

  const result = streamText({
    ...modelArgs(
      { plan, run, maxRetries, ...conversation },
      noProgress,
      overflowRecovery,
    ),
    onStepEnd: (step: RunStep) => {
      completedSteps.push(step as LoopStep);
      stepMessages.push(
        ...((step as { response?: { messages?: ModelMessage[] } }).response
          ?.messages ?? []),
      );
      onStepFinish?.(step);
      run.onStep(step);
    },
    onChunk: () => {
      run.onStreamChunk();
    },
    onToolExecutionEnd: (ctx) => {
      onToolExecutionEnd?.(ctx);
    },
    onError: ({ error }) => {
      recordFailure(error);
    },
  });

  const extractMetadata = createMessageMetadata({
    ...facts,
    toolDurations,
    stepCeiling: plan.maxSteps,
    driveStartMs,
    delegatedUsage: run.delegatedUsage,
    continued: continued?.metadata,
    isClearableTool: (toolName) =>
      isClearableToolName(
        toolName,
        (n) => plan.readOnlyToolNames?.has(n) ?? false,
      ),
  });

  const chunks = toUIMessageStream<typeof plan.tools, PlatypusUIMessage>({
    stream: overflowRecovery.injectToolErrors(result.stream),
    tools: plan.tools,
    originalMessages,
    generateMessageId,
    messageMetadata: (part) => {
      const metadata = extractMetadata(part);
      if (metadata?.truncatedByTokenLimit) truncated = true;
      if (metadata?.stoppedAtStepLimit) stoppedAtStepLimit = true;
      return metadata;
    },
    onError: (error) => formatStreamError(error),
    ...(onEnd ? { onEnd: ({ messages }) => onEnd(messages) } : {}),
  });

  const outcome = async (): Promise<ModelLoopOutcome> => {
    const cutoffs = {
      failure,
      failureError,
      truncated,
      stoppedAtStepLimit: !noProgress?.tripped() && stoppedAtStepLimit,
    };
    try {
      const [text, finishReason, rawFinishReason, steps, totalUsage] =
        await Promise.all([
          result.text,
          result.finishReason,
          result.rawFinishReason,
          result.steps,
          result.usage,
        ]);
      return {
        ...cutoffs,
        text: typeof text === "string" ? text : "",
        finishReason,
        rawFinishReason,
        steps: (steps as LoopStep[] | undefined) ?? [],
        totalUsage,
        stepMessages,
        completedSteps,
      };
    } catch (error) {
      return {
        ...cutoffs,
        text: "",
        finishReason: undefined,
        rawFinishReason: undefined,
        steps: [],
        totalUsage: {},
        stepMessages,
        completedSteps,
        rejection: { error },
      };
    }
  };

  return {
    chunks,
    reportFailure: recordFailure,
    outcome,
  };
};

type SwitchDecision = {
  modelSwitch: ModelSwitch;
  fallback: FallbackTurn;
  primaryFailure: string;
};

const fallbackSwitchFor = ({
  fallback,
  run,
  outcome,
  from,
  stepsUsed,
  maxSteps,
}: {
  fallback: FallbackTurn | undefined;
  run: RunLifecycle;
  outcome: ModelLoopOutcome;
  from: UsageModel;
  stepsUsed: number;
  maxSteps: number;
}): SwitchDecision | null => {
  if (!fallback || run.handle.signal.aborted) return null;
  if (stepsUsed >= maxSteps) return null;
  if (!outcome.failure && !outcome.rejection) return null;
  const error = outcome.failureError ?? outcome.rejection?.error;
  if (!isProviderUnavailableError(error)) return null;
  const to = fallback.plan.usageModel;
  return {
    modelSwitch: {
      from: { providerId: from.providerId, model: from.model },
      to: { providerId: to.providerId, model: to.model },
    },
    fallback,
    primaryFailure: outcome.failure ?? describeSdkError(error),
  };
};

const recordModelSwitch = ({
  run,
  events,
  modelSwitch,
  primaryFailure,
}: {
  run: RunLifecycle;
  events: RunEventScope | undefined;
  modelSwitch: ModelSwitch;
  primaryFailure: string;
}): void => {
  run.setStats({ ...run.stats, fallback: modelSwitch });
  if (!events) return;
  const id = events.recorder.open(events.parentEventId, {
    type: "model-switch",
    modelSwitch,
  });
  if (id) {
    events.recorder.close(id, { status: "completed", error: primaryFailure });
  }
};

const fallbackPlan = (
  plan: RunPlan,
  fallback: FallbackTurn,
  stepsUsed: number,
): RunPlan => ({
  ...pickPlanFields(fallback.plan, GENERATION_FIELDS),
  ...pickPlanFields(plan, TURN_FIELDS),
  maxSteps: Math.max(1, plan.maxSteps - stepsUsed),
  system: fallback.system,
});

const conversationMessages = (
  conversation: DriveConversation,
): ModelMessage[] =>
  conversation.prompt !== undefined
    ? [{ role: "user", content: conversation.prompt }]
    : conversation.modelMessages;

const FALLBACK_FAILURE_MAX_LENGTH = 400;

const capFailure = (message: string): string =>
  message.length <= FALLBACK_FAILURE_MAX_LENGTH
    ? message
    : `${message.slice(0, FALLBACK_FAILURE_MAX_LENGTH)}…`;

const switchToFallback = ({
  plan,
  conversation,
  fallback,
  stepMessages,
  stepsUsed,
}: {
  plan: RunPlan;
  conversation: DriveConversation;
  fallback: FallbackTurn;
  stepMessages: ModelMessage[];
  stepsUsed: number;
}): { plan: RunPlan; conversation: DriveConversation } => ({
  plan: fallbackPlan(plan, fallback, stepsUsed),
  conversation: {
    modelMessages: sanitizeMessagesForFallback([
      ...conversationMessages(conversation),
      ...stepMessages,
    ]),
  },
});

export const fallbackFailureMessage = (
  primaryFailure: string,
  fallbackFailure: string,
): string =>
  `The primary model failed: ${capFailure(primaryFailure)} The Fallback model also failed: ${capFailure(fallbackFailure)}`;

export type AttemptSequence = {
  current: () => {
    plan: RunPlan;
    conversation: DriveConversation;
    maxRetries?: number;
  };
  settle: (outcome: ModelLoopOutcome) =>
    | { next: true }
    | {
        next: false;
        failure?: string;
        modelSwitch?: ModelSwitch;
      };
};

export const attemptSequence = (opts: {
  plan: RunPlan;
  conversation: DriveConversation;
  fallback: FallbackTurn | undefined;
  run: RunLifecycle;
  events: RunEventScope | undefined;
}): AttemptSequence => {
  const { run, events } = opts;
  let { plan, conversation } = opts;
  let fallback = opts.fallback;
  let switched: { modelSwitch: ModelSwitch; primaryFailure: string } | null =
    null;
  const maxRetries = opts.fallback ? FALLBACK_SDK_RETRIES : undefined;

  return {
    current: () => ({
      plan,
      conversation,
      ...(maxRetries !== undefined ? { maxRetries } : {}),
    }),
    settle: (outcome) => {
      const steps =
        outcome.steps.length > 0 ? outcome.steps : outcome.completedSteps;
      const decision = fallbackSwitchFor({
        fallback,
        run,
        outcome,
        from: plan.usageModel,
        stepsUsed: steps.length,
        maxSteps: plan.maxSteps,
      });
      if (decision) {
        const { modelSwitch, primaryFailure } = decision;
        switched = { modelSwitch, primaryFailure };
        fallback = undefined;
        recordModelSwitch({ run, events, modelSwitch, primaryFailure });
        ({ plan, conversation } = switchToFallback({
          plan,
          conversation,
          fallback: decision.fallback,
          stepMessages: outcome.stepMessages,
          stepsUsed: steps.length,
        }));
        return { next: true };
      }
      const failure =
        outcome.failure ??
        (outcome.rejection && !run.handle.signal.aborted
          ? describeSdkError(outcome.rejection.error)
          : undefined);
      return {
        next: false,
        ...(failure !== undefined
          ? {
              failure: switched
                ? fallbackFailureMessage(switched.primaryFailure, failure)
                : failure,
            }
          : {}),
        ...(switched ? { modelSwitch: switched.modelSwitch } : {}),
      };
    },
  };
};

const runStreamedDrive = (
  opts: ChatDriveOptions,
  behavior: StreamedBehavior,
  split: SplitStream,
  causation: { agentId?: string; child: boolean },
): StreamedCore => {
  const {
    run,
    originalMessages: given = [],
    toolDurations,
    onFinal,
    events,
    fallback,
    prompt: givenPrompt,
    modelMessages: givenMessages,
    ...loopOpts
  } = opts;

  const noProgress = detectorFor(behavior.unattended);
  const continued = withoutCutShortFlags(
    given.at(-1)?.role === "assistant" ? given.at(-1) : undefined,
  );
  const originalMessages = continued
    ? [...given.slice(0, -1), continued]
    : given;

  let finalHandedOver = false;
  let latest: PlatypusUIMessage | undefined;
  let handoverMessages: PlatypusUIMessage[] | undefined;
  let resolveDone!: (result: StreamedDriveResult) => void;
  const done = new Promise<StreamedDriveResult>((resolve) => {
    resolveDone = resolve;
  });

  const attempts = attemptSequence({
    plan: opts.plan,
    conversation:
      givenPrompt !== undefined
        ? { prompt: givenPrompt }
        : { modelMessages: givenMessages },
    fallback,
    run,
    events,
  });
  let foldMessages = originalMessages;
  let seed: PlatypusUIMessage | undefined = continued;

  const startLoop = (): {
    loop: ModelLoop;
    consume: ReadableStream<InferUIMessageChunk<PlatypusUIMessage>>;
  } => {
    const { conversation, ...attempt } = attempts.current();
    const build = () =>
      modelLoop({
        ...loopOpts,
        ...conversation,
        ...attempt,
        run,
        originalMessages: foldMessages,
        continued: seed,
        noProgress,
        onEnd: (finalMessages) => {
          finalHandedOver = true;
          const withDurations =
            toolDurations && toolDurations.size > 0
              ? applyToolDurations(finalMessages, toolDurations)
              : finalMessages;
          handoverMessages = normalizeWebToolParts(withDurations);
          onFinal?.(handoverMessages);
        },
      });
    const loop =
      causation.child && causation.agentId
        ? withChildCausation(causation.agentId, build)
        : withAgentCausation(causation.agentId, build);

    // why: the SDK reuses a continued message id but re-emits none of its parts
    const withSeeded = loop.chunks.pipeThrough(replaySeededParts(foldMessages));

    const consume = split(
      events ? withSeeded.pipeThrough(recordRunEvents(events)) : withSeeded,
    );
    return { loop, consume };
  };

  let current = startLoop();

  const snapshots: AsyncIterable<PlatypusUIMessage> = (async function* () {
    for (;;) {
      const { loop, consume } = current;

      try {
        for await (const message of readUIMessageStream<PlatypusUIMessage>({
          // why: a resumed reply keeps parts the stream never re-sends, only updates by id
          ...(seed ? { message: structuredClone(seed) } : {}),
          stream: consume,
          onError: (error) => {
            loop.reportFailure(error);
          },
        })) {
          // why: a search must render the same live as after a reload
          const normalized = normalizeWebToolMessage(message);
          latest = normalized;
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- set in a callback, which TS narrowing does not track
          if (behavior.stopSnapshotsAfterFinal && finalHandedOver) continue;
          yield normalized;
        }
      } catch (error) {
        logger.error(
          { err: error, runId: run.handle.runId },
          "Server-side UI stream consumer error",
        );
        loop.reportFailure(error);
      }

      const outcome = await loop.outcome();
      const settled = attempts.settle(outcome);
      if (settled.next) {
        foldMessages = latest ? [latest] : [];
        seed = latest;
        finalHandedOver = false;
        current = startLoop();
        continue;
      }

      if (outcome.truncated || outcome.stoppedAtStepLimit) {
        run.setStats(withCutoffs(run.stats, outcome));
      }
      const decision = decideTerminalStatus(run, {
        failure: settled.failure,
        noProgress,
        failOnStreamError: behavior.failOnStreamError,
      });
      events?.recorder.closeOpen(
        eventStatusForRun(decision.status),
        events.parentEventId,
      );
      await run.finish(decision.status, decision.error);
      resolveDone({
        status: decision.status,
        messages: handoverMessages,
        latest,
        failure: decision.failure,
        truncated: outcome.truncated,
        stoppedAtStepLimit: outcome.stoppedAtStepLimit,
      });
      break;
    }
  })();

  return { snapshots, done };
};

const withAbortNotice = (
  run: RunLifecycle,
): TransformStream<
  InferUIMessageChunk<PlatypusUIMessage>,
  InferUIMessageChunk<PlatypusUIMessage>
> =>
  new TransformStream({
    transform(chunk, controller) {
      controller.enqueue(chunk);
    },
    flush(controller) {
      const reason: unknown = run.handle.signal.reason;
      if (!(reason instanceof TimeoutError)) return;
      logger.warn(
        { runId: run.handle.runId, kind: reason.kind },
        "Reporting run timeout to the client",
      );
      controller.enqueue({
        type: "error",
        errorText: describeTimeout(reason),
      });
    },
  });

export type ChatDrive = StreamedCore & {
  response: ReadableStream<InferUIMessageChunk<PlatypusUIMessage>>;
};

export const driveChat = (opts: ChatDriveOptions): ChatDrive => {
  let response!: ReadableStream<InferUIMessageChunk<PlatypusUIMessage>>;
  const core = runStreamedDrive(
    opts,
    {
      unattended: false,
      failOnStreamError: false,
      stopSnapshotsAfterFinal: true,
    },
    (ui) => {
      const [client, serverSide] = ui.tee();
      response = client.pipeThrough(withAbortNotice(opts.run));
      return serverSide;
    },
    { agentId: opts.facts?.agentId, child: false },
  );
  return { ...core, response };
};

export const driveDelegate = (opts: DelegateDriveOptions): StreamedCore => {
  const { agentId, ...rest } = opts;
  return runStreamedDrive(
    rest,
    {
      unattended: true,
      failOnStreamError: true,
      stopSnapshotsAfterFinal: false,
    },
    (ui) => ui,
    { agentId, child: true },
  );
};

export type DriveOnceOptions = DriveBase &
  DriveConversation & {
    agentId?: string;
    events?: RunEventRecorder;
    onFinal?: (text: string) => void;
    onSnapshot?: (message: PlatypusUIMessage) => void;
    fallback?: FallbackTurn;
  };

const foldReply = (
  seed: PlatypusUIMessage,
  onFold: (message: PlatypusUIMessage) => void,
) => {
  let feed!: ReadableStreamDefaultController<
    InferUIMessageChunk<PlatypusUIMessage>
  >;
  const reading = (async () => {
    for await (const message of readUIMessageStream<PlatypusUIMessage>({
      message: structuredClone(seed),
      stream: new ReadableStream({ start: (c) => void (feed = c) }),
    })) {
      onFold(normalizeWebToolMessage(message));
    }
  })().catch((error: unknown) => {
    logger.error({ err: error }, "Error folding a headless run's reply");
  });
  const quietly = (write: () => void) => {
    try {
      write();
    } catch {
      // why: a failed fold cancels its feed; already logged, the run goes on without it
    }
  };
  return {
    push: (chunk: InferUIMessageChunk<PlatypusUIMessage>) =>
      quietly(() => feed.enqueue(chunk)),
    end: () => {
      quietly(() => feed.close());
      return reading;
    },
  };
};

const logHeadlessCompletion = (
  run: RunLifecycle,
  outcome: ModelLoopOutcome,
  stats: RunStats,
  startTime: number,
  error: Error | undefined,
): void => {
  const trip =
    error instanceof NoProgressError
      ? { toolName: error.toolName, count: error.count }
      : null;
  logger[trip ? "warn" : "info"](
    {
      runId: run.handle.runId,
      ...(trip ? { toolName: trip.toolName, count: trip.count } : {}),
      duration: Date.now() - startTime,
      responseLength: outcome.text.length,
      finishReason: outcome.finishReason,
      rawFinishReason: outcome.rawFinishReason,
      stats,
    },
    trip ? "Run aborted: no progress" : "Run generate completed",
  );
};

export const driveOnce = async (
  opts: DriveOnceOptions,
): Promise<{ text: string; stats: RunStats }> => {
  const { run } = opts;
  const noProgress = detectorFor(true);
  const startTime = Date.now();
  const {
    agentId,
    onFinal,
    onSnapshot,
    events: recorder,
    fallback,
    plan: initialPlan,
    ...loopOpts
  } = opts;
  const scope: RunEventScope | undefined = recorder
    ? { recorder, parentEventId: null }
    : undefined;

  const {
    prompt: _prompt,
    modelMessages: _modelMessages,
    ...baseOpts
  } = loopOpts;

  try {
    const attempts = attemptSequence({
      plan: initialPlan,
      conversation:
        loopOpts.prompt !== undefined
          ? { prompt: loopOpts.prompt }
          : { modelMessages: loopOpts.modelMessages },
      fallback,
      run,
      events: scope,
    });
    let reply: PlatypusUIMessage = {
      id: createIdGenerator({ prefix: "msg", size: 16 })(),
      role: "assistant",
      parts: [],
    };
    const finalOutcome = await (async (): Promise<ModelLoopOutcome> => {
      for (;;) {
        const { conversation, ...attempt } = attempts.current();
        const loop = withAgentCausation(agentId, () =>
          modelLoop({
            ...baseOpts,
            ...conversation,
            ...attempt,
            noProgress,
            events: scope,
          }),
        );

        const fold = foldReply(reply, (message) => {
          reply = message;
          onSnapshot?.(message);
        });
        try {
          for await (const chunk of loop.chunks) {
            if (scope) recordUiChunk(scope, chunk);
            fold.push(chunk);
          }
        } finally {
          await fold.end();
        }
        const outcome = await loop.outcome();
        const settled = attempts.settle(outcome);
        if (settled.next) continue;

        if (
          settled.failure !== undefined &&
          (outcome.failure !== undefined || settled.modelSwitch)
        ) {
          throw new Error(settled.failure);
        }
        if (outcome.rejection) {
          throw outcome.rejection.error instanceof Error
            ? outcome.rejection.error
            : new Error(describeSdkError(outcome.rejection.error));
        }
        return outcome;
      }
    })();

    const stats = withCutoffs(run.stats, finalOutcome);
    run.setStats(stats);

    const decision = decideTerminalStatus(run, {
      noProgress,
      failOnStreamError: false,
      emptyAtOutputCeiling:
        !!stats.truncatedByTokenLimit && !finalOutcome.text.trim(),
    });
    logHeadlessCompletion(run, finalOutcome, stats, startTime, decision.error);

    onFinal?.(finalOutcome.text);
    await run.finish(decision.status, decision.error);
    return { text: finalOutcome.text, stats };
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error(
      { error, runId: run.handle.runId, duration: Date.now() - startTime },
      "Run generate failed",
    );
    const decision = decideTerminalStatus(run, {
      noProgress,
      failOnStreamError: false,
    });
    if (run.handle.signal.aborted) {
      await run.finish(decision.status, decision.error);
    } else {
      await run.finish("failed", err);
    }
    throw err;
  }
};
