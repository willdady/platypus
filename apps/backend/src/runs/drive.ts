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

/**
 * The model call inside a registered run.
 *
 * Every entry point that turns a prompt or a Chat history into a model answer
 * drives it from here, so the rules that hold for all of them are stated once:
 * how the invocation is assembled (step ceiling and stop conditions), which
 * terminal status the run ends with, and when a cutoff — the output ceiling, or
 * the step ceiling stopping the loop — is recorded on its stats.
 *
 * Three entry points, one per shape a caller needs:
 *
 * - `driveChat` — an interactive Chat turn. Splits off a client stream, renders
 *   a stream error inline rather than failing the run, and stops yielding
 *   snapshots once the terminal finish has handed its folded messages over.
 * - `driveDelegate` — an unattended, delegated sub-Agent. Gains the no-progress
 *   stop condition, fails when its stream reports an error (so a crash is never
 *   read as the finding), and yields every snapshot into the caller's activity
 *   log.
 * - `driveOnce` — the headless path (Triggers). Unattended by construction;
 *   streams to nobody, drains its own stream, and returns a single answer plus
 *   the computed stats.
 *
 * All three run on `streamText`, so one instrumentation surface — the UI
 * message stream — serves them all (#647): the headless drive and a delegate's
 * record their **Run events** off the same chunks, through `runs/run-events.ts`.
 *
 * Both streamed drives expose the folded messages as an async iterable plus a
 * `done` outcome, so a caller that must *yield* per snapshot and one that must
 * hand a stream to a client immediately each keep their own pacing.
 */

/**
 * The conversation, in the one form its caller holds it: a delegated run has a
 * single task `prompt`, a Chat turn has already-converted `modelMessages`. A
 * union rather than two optionals, so a caller cannot pass both or neither.
 */
type DriveConversation =
  | { prompt: string; modelMessages?: never }
  | { prompt?: never; modelMessages: ModelMessage[] };

/** What every drive needs, whichever shape it takes. */
type DriveBase = {
  plan: RunPlan;
  run: RunLifecycle;
};

/** The conversation as the SDK takes it — exactly one of the two keys. */
const conversationArgs = (conversation: DriveConversation) =>
  conversation.prompt !== undefined
    ? { prompt: conversation.prompt }
    : { messages: conversation.modelMessages };

/**
 * The arguments every drive hands the SDK: the shared assembly (model, tools,
 * system, ceilings, sampling), this run's abort signal, the unattended stop
 * condition when there is one, and the conversation.
 */
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

/** An unattended run gets the no-progress detector; an attended one does not. */
const detectorFor = (unattended: boolean): NoProgressDetector | null =>
  unattended ? createNoProgressDetector() : null;

/**
 * The plan with its locally-executed tools wrapped to record Run events under
 * `scope` — or as it was, for a drive that records none (a Chat turn).
 */
const planRecording = (plan: RunPlan, scope: RunEventScope | undefined) =>
  scope ? { ...plan, tools: wrapToolsWithRunEvents(plan.tools, scope) } : plan;

/**
 * A continued reply without the marks saying how its last request ended:
 * whether a resumed reply was cut short is this request's to say, and the
 * SDK's merge would otherwise keep a mark the request never set.
 */
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

/** What a streamed drive settled on. */
export type StreamedDriveResult = {
  /** The terminal status the run was finished with. Reported so a caller that
   *  must tell a cancellation from a fault never re-derives one. */
  status: RunStatus;
  /** The Chat turn's final folded messages (tool durations applied). */
  messages?: PlatypusUIMessage[];
  /** The last snapshot seen — the delegate's final assistant message. */
  latest?: PlatypusUIMessage;
  /** Why a non-clean drive ended, in a caller-facing sentence. Absent for a
   *  clean finish. */
  failure?: string;
  /** The terminal finish hit the model's output ceiling. */
  truncated: boolean;
  /** The model loop was stopped at its step ceiling with the model still asking
   *  to continue, so the answer is whatever it had produced by then. */
  stoppedAtStepLimit: boolean;
};

type TerminalDecision = {
  status: RunStatus;
  error?: Error;
  /** A caller-facing sentence for a non-clean end, when one is reported. */
  failure?: string;
};

/**
 * The one terminal-status rule, in a registered run's terms.
 *
 * Decides the status an ended run carries, the error it records, and — for a
 * drive that treats a stream error as fatal — the sentence its caller is told.
 * Every drive ends through this, so none re-derives "did we succeed?" from the
 * stream or result it happened to be holding.
 */
const decideTerminalStatus = (
  run: RunLifecycle,
  opts: {
    failure?: string;
    noProgress: NoProgressDetector | null;
    failOnStreamError: boolean;
    /**
     * The output ceiling cut the run before it wrote any answer. Only the
     * headless drive passes it: unattended, an empty answer is the only sign
     * the run produced nothing (#1690). A partial answer still succeeds with
     * its notice, and a step-ceiling stop is deliberate, so neither counts.
     */
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

  // What the stream reported outranks why we stopped: a run that both timed out
  // and reported an error is better explained by the error. Absent one, a run
  // that stopped mid-stream still owes its caller a reason it ended short — a
  // delegate's parent has to tell a stop from a finished answer.
  const stoppedShort = run.handle.signal.aborted
    ? run.abortReason()
      ? `Stopped before finishing: ${run.abortReason()}`
      : "Stopped before finishing."
    : undefined;
  const failure = opts.failure ?? stoppedShort;
  if (!failure) return { status, error };

  // A timed-out or cancelled run keeps the signal's own error: the timeout
  // names the bound that was exceeded, and a cancellation names who stopped it.
  // A failure only the stream saw becomes the run's error.
  return status === "succeeded"
    ? { status: "failed", error: new Error(failure), failure }
    : { status, error, failure };
};

/**
 * Ends a run that failed before any drive started — a delegate's tool setup
 * throwing is the case that exists — under the terminal-status rule a drive
 * would have applied, so that caller does not grow its own copy.
 */
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

/** The knobs the two streamed shapes differ on, frozen per entry point. */
type StreamedBehavior = {
  unattended: boolean;
  failOnStreamError: boolean;
  stopSnapshotsAfterFinal: boolean;
};

/** An interactive Chat turn's drive — also the widest streamed shape, so it is
 *  what the shared runner accepts. */
export type ChatDriveOptions = DriveBase &
  DriveConversation & {
    /** The opening messages a Chat turn folds its streamed answer onto. */
    originalMessages?: PlatypusUIMessage[];
    /**
     * What Turn resolution decided before this drive existed. Relayed whole to
     * the metadata extractor, which stamps it onto the streamed message; the
     * drive itself reads only `agentId`, for the causation chain. Absent for a
     * drive with no resolved turn behind it (a delegated sub-Agent).
     */
    facts?: TurnFacts;
    generateMessageId?: () => string;
    /** The live map the caller fills from `onToolExecutionEnd`. */
    toolDurations?: Map<string, number>;
    /** Hooked before the run folds the step, so the caller can read what it
     *  can't otherwise recover (e.g. the provider's raw finish reason). */
    onStepFinish?: (step: RunStep) => void;
    onToolExecutionEnd?: (ctx: {
      toolCall: { toolCallId: string };
      toolExecutionMs: number;
    }) => void;
    /** The folded final messages (tool durations applied), right before the run
     *  ends. The Chat turn persists these; the sink's terminal write observes
     *  them. */
    onFinal?: (messages: PlatypusUIMessage[]) => void;
    /**
     * Where this drive's Run events go, when it records any: a delegate's
     * scope, opened by the parent's delegation event. A Chat turn passes none
     * — its message parts remain its record (#647).
     */
    events?: RunEventScope;
    /**
     * A Fallback model this delegate may switch to (ADR-0043). Only a
     * Sub-Agent under a Trigger run passes one; a Chat turn never does.
     */
    fallback?: FallbackTurn;
  };

/** A delegated sub-Agent's drive: the same conversation and step hook, none of
 *  the Chat turn's folding and client-stream machinery. */
export type DelegateDriveOptions = DriveBase &
  DriveConversation & {
    onStepFinish?: (step: RunStep) => void;
    /**
     * The delegated Agent's id, always present — the only caller, the
     * Sub-Agent tool, always passes one. Appended to the parent run's ambient
     * causation chain for the duration of the delegate's drive, so a write the
     * delegate makes is attributed to every Agent above it too (ADR-0022,
     * issue #668).
     */
    agentId: string;
    /** The parent's scope for this delegate's events — see `ChatDriveOptions`. */
    events?: RunEventScope;
    /** This delegate's own Fallback model (ADR-0043), when it has one. */
    fallback?: FallbackTurn;
  };

/** Where a drive's UI stream goes before it is consumed. A Chat turn tees off a
 *  client branch here; a delegate consumes the stream whole. */
type SplitStream = (
  ui: ReadableStream<InferUIMessageChunk<PlatypusUIMessage>>,
) => ReadableStream<InferUIMessageChunk<PlatypusUIMessage>>;

type StreamedCore = {
  snapshots: AsyncIterable<PlatypusUIMessage>;
  done: Promise<StreamedDriveResult>;
};

/** What the shared loop is given, whichever shape consumes it. */
type ModelLoopOptions = DriveBase &
  DriveConversation &
  Omit<
    ChatDriveOptions,
    "onFinal" | keyof DriveBase | keyof DriveConversation
  > & {
    /** The unattended stop condition this loop runs under, when it has one. */
    noProgress: NoProgressDetector | null;
    /** The reply this loop continues, with its cut-short marks removed. */
    continued?: PlatypusUIMessage;
    /** The folded final messages, handed over by the terminal finish. */
    onEnd?: (messages: PlatypusUIMessage[]) => void;
    /**
     * The SDK retry budget for the model calls. Absent leaves the SDK's
     * default; the attempt sequence sets it (ADR-0043).
     */
    maxRetries?: number;
  };

/** The SDK result slice `computeStats` folds — what a headless run reports. */
type LoopStats = Parameters<typeof computeStats>[0];

/**
 * One completed step as the Drive holds it: the statistics `computeStats`
 * reads, plus the wider fields a Fallback switch needs — the token detail per
 * step and the response messages to continue from.
 */
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

/**
 * What one model loop settles on, once its chunk stream has drained.
 *
 * The loop owns the one cutoff rule: the terminal finish's metadata is read as
 * it passes through `createMessageMetadata`, so both shapes record an output-
 * or step-ceiling stop the same way. The no-progress exclusion is applied here
 * too — a tripped detector owns its stop and is never relabelled as a step
 * ceiling.
 */
export type ModelLoopOutcome = {
  /** The first failure the stream reported, in a caller-facing sentence. */
  failure?: string;
  /** The terminal finish hit the model's output ceiling. */
  truncated: boolean;
  /** The loop was stopped at its step ceiling with the model still asking to
   *  continue, so the answer is whatever it had produced by then. */
  stoppedAtStepLimit: boolean;
  /** The answer the loop produced. */
  text: string;
  /** The provider's unified terminal reason. */
  finishReason: string | undefined;
  /** The provider's raw terminal reason — what it actually said. */
  rawFinishReason: string | undefined;
  /** The steps the SDK completed, for a caller computing its own statistics. */
  steps: LoopStep[];
  /** The usage the provider reported across the loop. */
  totalUsage: LoopStats["totalUsage"];
  /** Why the result's terminal promises rejected, when they did. */
  rejection?: { error: unknown };
  /**
   * The error the stream itself reported, in its raw form. Kept beside the
   * caller-facing `failure` sentence so the Drive can classify it — whether a
   * Fallback model may answer it — rather than matching prose (ADR-0043).
   */
  failureError?: unknown;
  /**
   * The messages the completed steps generated, in SDK form. A switch to the
   * Fallback model continues from these plus the messages already sent, so the
   * earlier tool calls and their results survive it (ADR-0043).
   */
  stepMessages: ModelMessage[];
  /**
   * The steps the loop completed, collected as they ended. `steps` is empty
   * when the loop failed mid-run — its terminal promise rejects — so this is
   * the only record of the work the run was billed for before the failure.
   */
  completedSteps: LoopStep[];
};

/**
 * The cutoffs the loop decided, recorded on a run's statistics. One mapping,
 * so the streamed drives and the headless one cannot label a stop differently.
 */
const withCutoffs = (
  stats: RunStats,
  outcome: Pick<ModelLoopOutcome, "truncated" | "stoppedAtStepLimit">,
): RunStats => ({
  ...stats,
  ...(outcome.truncated ? { truncatedByTokenLimit: true as const } : {}),
  ...(outcome.stoppedAtStepLimit ? { stoppedAtStepLimit: true as const } : {}),
});

/** What one model loop hands its consumer. */
type ModelLoop = {
  /** The UI chunk stream to consume. */
  chunks: ReadableStream<InferUIMessageChunk<PlatypusUIMessage>>;
  /** Records a failure the stream's consumer saw — the first one wins. */
  reportFailure: (error: unknown) => void;
  /**
   * The loop's outcome. Called once the chunks have been drained: it awaits the
   * result's terminal promises and reads the cutoffs the extractor captured
   * while the stream flowed.
   */
  outcome: () => Promise<ModelLoopOutcome>;
};

/**
 * The one model loop every shape consumes.
 *
 * Owns everything the three drives did identically: setting the usage model,
 * wrapping the plan's tools for Run events, both halves of context-overflow
 * recovery, `streamText` with the shared callbacks, the UI message stream with
 * its metadata extractor and stream-error capture, and the single cutoff rule.
 * What differs between a Chat turn, a delegate and a headless Trigger run is
 * how the returned chunks are consumed and how the run ends — not the loop.
 */
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
  // The first error the stream reported, in a caller-facing sentence and in
  // its raw form — the latter for a Fallback switch's classifier.
  let failure: string | undefined;
  let failureError: unknown;
  const recordFailure = (error: unknown): void => {
    if (failure === undefined) failureError = error;
    failure ??= describeSdkError(error);
  };
  // The messages the completed steps generated, which a Fallback switch
  // continues from.
  const stepMessages: ModelMessage[] = [];
  const completedSteps: LoopStep[] = [];
  // The terminal finish's cutoffs, read off the metadata extractor below.
  let truncated = false;
  let stoppedAtStepLimit = false;

  // The Drive's own start — the boundary the brief in issue #354 calls
  // "where the model stream is created". Captured here, immediately before
  // `streamText`, rather than where `createMessageMetadata` is built a few
  // lines down: that gap is real code, not a rounding nicety, and this is the
  // earliest point the model request can be said to have been sent.
  const driveStartMs = Date.now();

  const result = streamText({
    ...modelArgs(
      { plan, run, maxRetries, ...conversation },
      noProgress,
      overflowRecovery,
    ),
    onStepEnd: (step: RunStep) => {
      // The SDK's step result is wider than `RunStep`; the response messages
      // are read here for a possible Fallback switch (ADR-0043).
      completedSteps.push(step as LoopStep);
      stepMessages.push(
        ...((step as { response?: { messages?: ModelMessage[] } }).response
          ?.messages ?? []),
      );
      onStepFinish?.(step);
      run.onStep(step);
    },
    // The only thing that proves a long-running step is still alive. Without
    // it the idle timer sees a silent gap for the whole of a long answer.
    onChunk: () => {
      run.onStreamChunk();
    },
    onToolExecutionEnd: (ctx) => {
      onToolExecutionEnd?.(ctx);
    },
    // A provider error after some output does not reject the result's promises
    // — it arrives as an error part and the stream ends normally — so the
    // headless shape would otherwise read a crash as a clean finish. The
    // streamed shapes fold the same error through `readUIMessageStream`'s own
    // `onError`; whichever reports first wins.
    onError: ({ error }) => {
      recordFailure(error);
    },
  });

  const extractMetadata = createMessageMetadata({
    ...facts,
    toolDurations,
    // The ceiling the invocation's step-count stop condition is built from.
    // The extractor sees the terminal finish reason but has no other way to
    // know whether the loop was stopped or the model was done.
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
    // The one place a cutoff is decided: the extractor is what stamps the
    // terminal finish, and both shapes read the same marks from it.
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
      // A no-progress abort halts the loop on the same terminal finish reason
      // the step ceiling does, and under a ceiling as low as the detector's own
      // threshold it can trip on the ceiling step itself. That stop already
      // reports itself — a failed run carrying a `no_progress:` message — and is
      // never relabelled as a step-ceiling stop.
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
        // A test double's `streamText` result can omit usage; normalize it
        // here so the drive always reads the documented shape.
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- the runtime value can be absent though the type says otherwise
        totalUsage: totalUsage ?? {},
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

/** What a switch decision hands the caller that must perform it. */
type SwitchDecision = {
  modelSwitch: ModelSwitch;
  /** The fallback this switch runs on. */
  fallback: FallbackTurn;
  /** The primary's failure, in a caller-facing sentence. */
  primaryFailure: string;
};

/**
 * Whether this ended loop is the primary's Provider failing in the class a
 * Fallback model may answer (ADR-0043). False when there is no fallback (or it
 * has already been used), the run was stopped, the failure is not the
 * Provider's, or either pair is unnamed (a hand-built test plan).
 */
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
  from: UsageModel | undefined;
  stepsUsed: number;
  maxSteps: number;
}): SwitchDecision | null => {
  if (!fallback || run.handle.signal.aborted) return null;
  // The step ceiling counts across the whole run: a primary that already spent
  // it leaves nothing for the fallback, so the run ends as it failed.
  if (stepsUsed >= maxSteps) return null;
  if (!outcome.failure && !outcome.rejection) return null;
  const error = outcome.failureError ?? outcome.rejection?.error;
  if (!isProviderUnavailableError(error)) return null;
  const to = fallback.plan.usageModel;
  if (!from || !to) return null;
  return {
    modelSwitch: {
      from: { providerId: from.providerId, model: from.model },
      to: { providerId: to.providerId, model: to.model },
    },
    fallback,
    primaryFailure: outcome.failure ?? describeSdkError(error),
  };
};

/**
 * Records a switch on the run: the run-level marker every reader uses (the
 * runs list, the webhook payload) and the zero-duration `model-switch` event
 * on the timeline, with the primary's capped error.
 *
 * Recorded at switch time, not at the end, so a run that switched and then
 * failed still carries the marker — a failed run's terminal write is the one
 * that most needs to explain the model it was on.
 */
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

/**
 * The same plan on the fallback, with the step ceiling counting across the
 * whole run (ADR-0043): the fallback's generation fields and the primary's
 * turn fields.
 */
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

/** The messages a loop's request carried, in the shape a switch continues from. */
const conversationMessages = (
  conversation: DriveConversation,
): ModelMessage[] =>
  conversation.prompt !== undefined
    ? [{ role: "user", content: conversation.prompt }]
    : conversation.modelMessages;

/** How much of each failure the run's error keeps. */
const FALLBACK_FAILURE_MAX_LENGTH = 400;

const capFailure = (message: string): string =>
  message.length <= FALLBACK_FAILURE_MAX_LENGTH
    ? message
    : `${message.slice(0, FALLBACK_FAILURE_MAX_LENGTH)}…`;

/**
 * The plan and conversation a switched run continues with: the fallback's
 * generation plan with the step ceiling counting across the run, and the
 * messages already sent plus every completed step's — reasoning and
 * vendor-only metadata stripped (ADR-0043).
 */
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

/** The run's error when the fallback failed too: both, each capped. */
export const fallbackFailureMessage = (
  primaryFailure: string,
  fallbackFailure: string,
): string =>
  `The primary model failed: ${capFailure(primaryFailure)} The Fallback model also failed: ${capFailure(fallbackFailure)}`;

/** The Fallback attempt sequence of one run (ADR-0043). */
export type AttemptSequence = {
  /** What the next loop runs on. Called once before each loop is built. */
  current: () => {
    plan: RunPlan;
    conversation: DriveConversation;
    maxRetries?: number;
  };
  /**
   * Hands over an ended loop. Either the sequence switched to the fallback —
   * the switch recorded on the run, and the caller builds a new loop from
   * `current()` — or it settled.
   */
  settle: (outcome: ModelLoopOutcome) =>
    | { next: true }
    | {
        next: false;
        /**
         * The caller-facing sentence for a non-clean end — both failures when
         * the run switched. A rejection of a stopped run is the stop's to
         * explain, so it is left out.
         */
        failure?: string;
        /** The switch this run made, when it made one. */
        modelSwitch?: ModelSwitch;
      };
};

/**
 * The attempts one run makes: the primary, then at most one switch to its
 * Fallback model on a Provider failure (ADR-0043). Owns everything around a
 * loop but its consumption, which differs per Drive shape.
 */
export const attemptSequence = (opts: {
  plan: RunPlan;
  conversation: DriveConversation;
  fallback: FallbackTurn | undefined;
  run: RunLifecycle;
  events: RunEventScope | undefined;
}): AttemptSequence => {
  const { run, events } = opts;
  let { plan, conversation } = opts;
  /** Cleared once used: a run switches at most once. */
  let fallback = opts.fallback;
  let switched: { modelSwitch: ModelSwitch; primaryFailure: string } | null =
    null;
  // One SDK retry before a switch, rather than the default two. Absent a
  // fallback the SDK's default stands.
  const maxRetries = opts.fallback ? FALLBACK_SDK_RETRIES : undefined;

  return {
    current: () => ({
      plan,
      conversation,
      ...(maxRetries !== undefined ? { maxRetries } : {}),
    }),
    settle: (outcome) => {
      // A loop that failed mid-run has an empty `steps` (its terminal promise
      // rejected); the steps it completed before that are still billed and
      // still count towards the ceiling.
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
        // The next loop runs on the fallback with the step ceiling counting
        // across the whole run, and continues from what the primary already
        // sent — reasoning and vendor-only metadata stripped.
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

/**
 * Runs the shared model loop inside its registered lifecycle and folds the
 * streamed parts into `PlatypusUIMessage`s — metadata, tool durations, stream
 * errors and the terminal finish all handled here — then records the terminal
 * status exactly once, when the snapshot stream drains.
 *
 * A delegate under a Trigger may switch to its own Fallback model mid-run
 * (ADR-0043): the loop is rebuilt on the fallback and the snapshot stream goes
 * on yielding, so the caller sees one continuous run.
 */
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
  /** The reply this turn continues: a seeded `/skill` one, or a resumed one. */
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

  // Only a delegate under a Trigger carries a fallback.
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
  /** The UI conversation the stream folds onto. */
  let foldMessages = originalMessages;
  let seed: PlatypusUIMessage | undefined = continued;

  /**
   * Starts a model loop and its chunk stream. Called once before the snapshot
   * generator exists, because the Chat's client branch is teed off
   * synchronously — and again on a switch, inside the same causation context
   * so the new loop's tool executions are attributed like the first.
   */
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
          // The terminal finish, stamped with the locally-measured tool
          // durations and the normalized web-tool view (issue #525) — same
          // order both apply in the read path (`routes/chat.ts`), for one
          // composed shape either way.
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

    // A continued assistant message's own parts, put back on the stream
    // before anything downstream reads it — the SDK reuses the message's id
    // but re-emits nothing, and its own fold is the only consumer that
    // already has them. See `replay-seeded-parts.ts`.
    const withSeeded = loop.chunks.pipeThrough(replaySeededParts(foldMessages));

    // Recorded before the split, so the delegate's Run events see every chunk
    // whichever branch is read first, and a Chat turn (no scope) pays nothing.
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
          // Folded onto, as the SDK's own fold is: a reply resumed after its
          // approvals were answered holds parts the stream never re-sends, and
          // goes on to update them by id.
          ...(seed ? { message: structuredClone(seed) } : {}),
          stream: consume,
          onError: (error) => {
            loop.reportFailure(error);
          },
        })) {
          // Normalized live, not only on the folded final: a search must render
          // identically while streaming and after a reload (issue #525), and the
          // final's own normalization run happens separately, in `onEnd` above.
          const normalized = normalizeWebToolMessage(message);
          latest = normalized;
          // Drain past the handover but don't yield: a snapshot after the folded
          // final is no better than what it would overwrite (no durations).
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

      // The cutoffs were decided once, as the loop's terminal finish passed
      // through its metadata extractor; the run records them from here.
      const outcome = await loop.outcome();
      const settled = attempts.settle(outcome);
      if (settled.next) {
        // The fallback's loop folds onto what the primary already streamed.
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
      // This drive's own still-open events end with it — a delegate that
      // failed mid-answer must not leave a `text` event running under a
      // `delegate` event that has already errored.
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

/**
 * Appends the reason an aborted run stopped to the client's branch of the
 * stream.
 *
 * An abort is not an error as far as the SDK is concerned: `streamText` closes
 * the stream on `isAbortError` rather than failing it, so `onError` never runs
 * and no error part is written. The client sees a clean end — the answer stops
 * mid-word, the submit button comes back, and nothing says why. That is how a
 * per-step timeout looked like no failure at all (issue #552).
 *
 * Only a timeout is reported. A cancellation reaches here the same way, but the
 * user pressed stop themselves and does not need to be told.
 */
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
  /** The client stream branch. Always present: a Chat turn is the shape that
   *  has one. */
  response: ReadableStream<InferUIMessageChunk<PlatypusUIMessage>>;
};

/**
 * Drives an interactive Chat turn.
 *
 * A human is watching, so the no-progress condition is left off (they can stop
 * it themselves) and a stream error is rendered inline rather than failing the
 * run. The client branch is teed off before the server-side consumer drains the
 * other, so a disconnected client never propagates back to the source.
 */
export const driveChat = (opts: ChatDriveOptions): ChatDrive => {
  // Assigned by `split` below, which `runStreamedDrive` calls synchronously
  // while constructing the drive — hence definite assignment before the return.
  let response!: ReadableStream<InferUIMessageChunk<PlatypusUIMessage>>;
  // The turn's Agent is what caused any write it makes; a direct (no-Agent)
  // turn establishes no causation and so never suppresses an Event Trigger
  // (ADR-0022).
  const core = runStreamedDrive(
    opts,
    {
      unattended: false,
      failOnStreamError: false,
      stopSnapshotsAfterFinal: true,
    },
    (ui) => {
      const [client, serverSide] = ui.tee();
      // Only the client branch carries the notice: the run itself already
      // records the timeout through `statusFromSignal`, so adding it to the
      // server-side drain would report the same failure twice.
      response = client.pipeThrough(withAbortNotice(opts.run));
      return serverSide;
    },
    // The turn's Agent is what caused any write it makes; a direct (no-Agent)
    // turn establishes no causation and so never suppresses an Event Trigger
    // (ADR-0022).
    { agentId: opts.facts?.agentId, child: false },
  );
  return { ...core, response };
};

/**
 * Drives a delegated sub-Agent.
 *
 * Nobody is watching this run's steps, so it gains the no-progress stop
 * condition (same call → same result, K times) and fails when its stream
 * reports an error, rather than letting the parent read a crash as the
 * delegate's finding. Every snapshot is yielded, for the caller's activity log.
 */
export const driveDelegate = (opts: DelegateDriveOptions): StreamedCore => {
  // The delegated Agent extends the ambient causation chain established by the
  // parent's drive: anything the delegate writes is attributed to it AND to
  // every Agent above it, so a parent's Event Trigger is still suppressed when
  // the work is done through a Sub-Agent (ADR-0022, issue #668).
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
    /**
     * The Agent this headless run is driving (a Trigger's agent). Establishes
     * the ambient causation chain the run's writes read as (ADR-0022): an
     * Event Trigger's own writes never re-fire it, at any delegation depth.
     */
    agentId?: string;
    /**
     * The run's **Run event** recorder (#647). Everything this drive observes
     * on its stream is recorded at the root, and the tools it runs carry the
     * recorder down so a delegate's events nest beneath its `delegate` event.
     * Absent, nothing is recorded.
     */
    events?: RunEventRecorder;
    /** The final assistant text, right before the run ends — so the sink's
     *  terminal write can persist it. */
    onFinal?: (text: string) => void;
    /**
     * The reply folded so far, each time it grows: one assistant message
     * carrying every attempt's text, reasoning and tool parts, so the sink
     * can keep the run's Transcript as a Chat (ADR-0044).
     */
    onSnapshot?: (message: PlatypusUIMessage) => void;
    /**
     * The Agent's Fallback model (ADR-0043). A Trigger run passes one when the
     * Agent has one; the drive switches on a Provider failure and stays on the
     * fallback for the rest of the run.
     */
    fallback?: FallbackTurn;
  };

/**
 * Folds UI message chunks onto `seed` as they are pushed, handing each fold to
 * `onFold`. `end` resolves once every pushed chunk has been folded.
 */
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
  // A fold that failed cancels its source, so the feed then throws; the
  // failure was already logged above, and the run goes on without the fold.
  const quietly = (write: () => void) => {
    try {
      write();
    } catch {
      // ignored: see above
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

/**
 * The one record of how a headless run ended: nobody is watching an unattended
 * run, and this is the only place the raw finish reason survives.
 */
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

/**
 * Drives a headless run inside its registered lifecycle.
 *
 * Returns a single answer and the computed statistics. Headless means
 * unattended, so the no-progress condition is always on. The terminal status and
 * both cutoffs — the output ceiling and the step ceiling — are decided by the
 * same rules the streamed drives apply, and the run is finished before
 * returning.
 *
 * On `streamText` rather than `generateText` (#647): the callbacks that tell
 * model time from tool time exist only on the streaming path, and without them
 * a step is one opaque block the waterfall cannot open. Nobody reads the
 * stream, so the drive drains it itself — through the UI message stream, which
 * is where Run events are read off, and then by awaiting the result's terminal
 * promises, which is what preserves `generateText`'s rejection on a provider
 * error with no output. A provider error *after* some output does not reject
 * — it arrives as an error part and the stream ends normally — so the drive
 * also reads `onError` and fails the run itself. `failOnStreamError` stays
 * `false` here as before: that flag is the shared decision function's, and
 * this drive owns its own failure rather than changing it.
 */
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

  // The plan's tool wrapping is inside the `try` too: nothing above this drive
  // finishes the run if it throws (issue #1122).
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
    // One reply across attempts: a Fallback switch folds onto what the
    // primary already streamed, as the streamed drives do.
    let reply: PlatypusUIMessage = {
      id: createIdGenerator({ prefix: "msg", size: 16 })(),
      role: "assistant",
      parts: [],
    };
    const finalOutcome = await (async (): Promise<ModelLoopOutcome> => {
      for (;;) {
        const { conversation, ...attempt } = attempts.current();
        // Built inside the causation chain so the SDK's stream keeps it alive for
        // every tool execution it drives (ADR-0022).
        const loop = withAgentCausation(agentId, () =>
          modelLoop({
            ...baseOpts,
            ...conversation,
            ...attempt,
            noProgress,
            events: scope,
          }),
        );

        // Drained through the UI message stream so the Run events are read off
        // the same chunks a delegate's are, and fed to a fold of the reply
        // beside it. The fold never throws into this loop: a stream that fails
        // fails the drive exactly as it did before the fold existed.
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

        // What the stream reported outranks what the result's promises rejected
        // with: a provider that throws before producing anything rejects them
        // with a generic "no output" error, and the reason is in the report.
        // A switched run's error names both failures; an unswitched
        // rejection is rethrown as it was.
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

    // Every step of every attempt was folded into the run's stats as it ended,
    // billed to the model that served it (ADR-0043).
    const stats = withCutoffs(run.stats, finalOutcome);
    run.setStats(stats);

    // The no-progress stop condition halts the loop cleanly (the SDK resolves
    // normally), so a tripped detector surfaces here rather than in the catch.
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
    // A stopped run is recorded as the stop says — cancelled with no error, or
    // failed with the `TimeoutError` — whatever the aborted call threw.
    // Anything the model call threw on its own is a failure with the thrown
    // error (there is no `TimeoutError` for a run that merely threw).
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
