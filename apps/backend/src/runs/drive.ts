import {
  generateText,
  readUIMessageStream,
  streamText,
  type InferUIMessageChunk,
  type ModelMessage,
} from "ai";
import { logger } from "../logger.ts";
import type { PlatypusUIMessage } from "../types.ts";
import { createMessageMetadata } from "./message-metadata.ts";
import {
  createNoProgressDetector,
  NoProgressError,
  type NoProgressDetector,
} from "./no-progress.ts";
import { buildModelInvocation, type RunPlan } from "./run-plan.ts";
import type { RunLifecycle } from "./run-lifecycle.ts";
import { describeTimeout, TimeoutError } from "./run-registry.ts";
import type { RunStep } from "./run-stats.ts";
import { computeStats } from "./run-stats.ts";
import {
  describeSdkError,
  formatStreamError,
  isTruncatedByTokenLimit,
} from "./stream-error.ts";
import { applyToolDurations } from "./tool-durations.ts";
import type { RunStats, RunStatus } from "./types.ts";

/**
 * The model call inside a registered run.
 *
 * Every entry point that turns a prompt or a Chat history into a model answer
 * drives it from here, so the rules that hold for all of them are stated once:
 * how the invocation is assembled (step ceiling and stop conditions), which
 * terminal status the run ends with, and when the output-ceiling cutoff is
 * recorded on its stats.
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
 * - `driveOnce` — the headless `generateText` path (Triggers). Unattended by
 *   construction; returns a single answer plus the computed stats.
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
export type DriveConversation =
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
  opts: DriveBase & DriveConversation,
  noProgress: NoProgressDetector | null,
) => ({
  ...buildModelInvocation(opts.plan, {
    abortSignal: opts.run.handle.signal,
    extraStopCondition: noProgress?.stopCondition,
  }),
  ...conversationArgs(opts),
});

/** An unattended run gets the no-progress detector; an attended one does not. */
const detectorFor = (unattended: boolean): NoProgressDetector | null =>
  unattended ? createNoProgressDetector() : null;

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
  },
): TerminalDecision => {
  const trip = opts.noProgress?.tripped() ?? null;
  if (trip) {
    const err = new NoProgressError(trip.toolName, trip.count);
    return { status: "failed", error: err, failure: err.message };
  }

  const { status, error } = run.statusFromSignal();
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
    /** The resolved Agent id, stamped onto the streamed message. */
    agentId?: string;
    /**
     * Turn resolution served no search tools for a turn that asked for search,
     * so the reply is written without it (issue #522). A setup-time fact on the
     * same path `agentId` takes: stamped onto the streamed message's metadata,
     * never onto the prompt.
     */
    searchUnavailable?: boolean;
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
  };

/** A delegated sub-Agent's drive: the same conversation and step hook, none of
 *  the Chat turn's folding and client-stream machinery. */
export type DelegateDriveOptions = DriveBase &
  DriveConversation & {
    onStepFinish?: (step: RunStep) => void;
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

/**
 * Runs a `streamText` model loop inside its registered lifecycle and folds the
 * streamed parts into `PlatypusUIMessage`s — metadata, tool durations, stream
 * errors and the terminal finish all handled here — then records the terminal
 * status exactly once, when the snapshot stream drains.
 */
const runStreamedDrive = (
  opts: ChatDriveOptions,
  behavior: StreamedBehavior,
  split: SplitStream,
): StreamedCore => {
  const {
    run,
    originalMessages = [],
    agentId,
    searchUnavailable,
    generateMessageId,
    toolDurations,
    onStepFinish,
    onToolExecutionEnd,
    onFinal,
  } = opts;

  const noProgress = detectorFor(behavior.unattended);

  let failure: string | undefined;
  let truncated = false;
  let finalHandedOver = false;
  let latest: PlatypusUIMessage | undefined;
  let handoverMessages: PlatypusUIMessage[] | undefined;
  let resolveDone!: (result: StreamedDriveResult) => void;
  const done = new Promise<StreamedDriveResult>((resolve) => {
    resolveDone = resolve;
  });

  const result = streamText({
    ...modelArgs(opts, noProgress),
    onStepFinish: (step: RunStep) => {
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
  });

  const uiStream = result.toUIMessageStream<PlatypusUIMessage>({
    originalMessages,
    generateMessageId,
    messageMetadata: createMessageMetadata({
      agentId,
      toolDurations,
      searchUnavailable,
    }),
    onError: (error) => formatStreamError(error),
    onFinish: ({ messages: finalMessages }) => {
      finalHandedOver = true;
      // The terminal finish, stamped with the locally-measured tool durations.
      handoverMessages =
        toolDurations && toolDurations.size > 0
          ? applyToolDurations(finalMessages, toolDurations)
          : finalMessages;
      onFinal?.(handoverMessages);
    },
  });

  const consume = split(uiStream);

  const snapshots: AsyncIterable<PlatypusUIMessage> = (async function* () {
    try {
      for await (const message of readUIMessageStream<PlatypusUIMessage>({
        stream: consume,
        onError: (error) => {
          failure ??= describeSdkError(error);
        },
      })) {
        latest = message;
        // Drain past the handover but don't yield: a snapshot after the folded
        // final is no better than what it would overwrite (no durations).
        if (behavior.stopSnapshotsAfterFinal && finalHandedOver) continue;
        yield message;
      }
    } catch (error) {
      logger.error(
        { err: error, runId: run.handle.runId },
        "Server-side UI stream consumer error",
      );
      failure ??= describeSdkError(error);
    } finally {
      // The terminal finish attaches the cutoff marker to the folded messages it
      // hands over; if that never fires (an abort before completion), the last
      // snapshot still carries it. Either way it is recorded once, before the
      // run's status is decided, so both the stats and the outcome agree.
      truncated =
        (handoverMessages?.some(
          (m) => m.metadata?.truncatedByTokenLimit === true,
        ) ??
          false) ||
        latest?.metadata?.truncatedByTokenLimit === true;
      if (truncated) {
        run.setStats({ ...run.stats, truncatedByTokenLimit: true });
      }
      const decision = decideTerminalStatus(run, {
        failure,
        noProgress,
        failOnStreamError: behavior.failOnStreamError,
      });
      await run.finish(decision.status, decision.error);
      resolveDone({
        status: decision.status,
        messages: handoverMessages,
        latest,
        failure: decision.failure,
        truncated,
      });
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
export const driveDelegate = (opts: DelegateDriveOptions): StreamedCore =>
  runStreamedDrive(
    opts,
    {
      unattended: true,
      failOnStreamError: true,
      stopSnapshotsAfterFinal: false,
    },
    (ui) => ui,
  );

/**
 * Drives a headless `generateText` run inside its registered lifecycle.
 *
 * Returns a single answer and the computed statistics. Headless means
 * unattended, so the no-progress condition is always on. The terminal status
 * and output-ceiling cutoff are decided by the same rules the streamed drives
 * apply, and the run is finished before returning.
 */
export const driveOnce = async (
  opts: DriveBase & DriveConversation,
): Promise<{ text: string; stats: RunStats }> => {
  const { run } = opts;
  const noProgress = detectorFor(true);
  const startTime = Date.now();

  try {
    const result = await generateText({
      ...modelArgs(opts, noProgress),
      onStepFinish: (step: RunStep) => run.onStep(step),
    });

    const stats = computeStats(result as Parameters<typeof computeStats>[0]);
    if (isTruncatedByTokenLimit(result.finishReason)) {
      stats.truncatedByTokenLimit = true;
    }
    run.setStats(stats);

    // The no-progress stop condition halts the loop cleanly (the SDK resolves
    // normally), so a tripped detector surfaces here rather than in the catch.
    const decision = decideTerminalStatus(run, {
      noProgress,
      failOnStreamError: false,
    });
    const trip =
      decision.error instanceof NoProgressError
        ? { toolName: decision.error.toolName, count: decision.error.count }
        : null;

    // Nobody is watching an unattended run, so this log is the only record of
    // how it ended, and the one place the raw finish reason survives.
    logger[trip ? "warn" : "info"](
      {
        runId: run.handle.runId,
        ...(trip ? { toolName: trip.toolName, count: trip.count } : {}),
        duration: Date.now() - startTime,
        responseLength: result.text.length,
        finishReason: result.finishReason,
        rawFinishReason: result.rawFinishReason,
        stats,
      },
      trip ? "Run aborted: no progress" : "Run generate completed",
    );

    await run.finish(decision.status, decision.error);
    return { text: result.text, stats };
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error(
      { error, runId: run.handle.runId, duration: Date.now() - startTime },
      "Run generate failed",
    );
    // A cancelled run is recorded as cancelled; a timed-out one stays a
    // failure, and so does anything the model call threw on its own. The status
    // choice is the shared one; only the error is the thrown one, not the
    // signal's (there is no `TimeoutError` for a run that merely threw).
    const decision = decideTerminalStatus(run, {
      noProgress,
      failOnStreamError: false,
    });
    await run.finish(
      decision.status === "cancelled" ? "cancelled" : "failed",
      err,
    );
    throw err;
  }
};
