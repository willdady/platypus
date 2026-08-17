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
 * This module is the single place that *drives* a run to its terminal state —
 * every entry point that turns a prompt or a Chat history into a model answer
 * goes through one of these two functions. What used to be re-derived in three
 * places (two paths in `AgentRunner`, plus the delegate tool) now lives here:
 *
 * - building the model invocation (`buildModelInvocation`, step ceiling and
 *   the no-progress stop condition included),
 * - the terminal-status decision (succeeded / failed / cancelled),
 * - recording the output-ceiling cutoff (`truncatedByTokenLimit`) once, on
 *   the run's stats,
 * - ending the run.
 *
 * `driveStreamed` is for the `streamText` path — a Chat turn (which tees a
 * client stream) and a delegated sub-Agent (which folds the snapshots into an
 * activity log). It exposes the folded messages as an async iterable the
 * caller consumes, plus a `done` promise with the outcome, so a caller that
 * must *yield* per snapshot (the delegate tool) and one that must hand the
 * stream to a client immediately (the Chat route) each keep their own pacing.
 *
 * `driveOnce` is for the tail-free `generateText` path (Trigger runs), which
 * returns a single text answer and the computed stats.
 */

/**
 * Which shape a streamed drive takes. The two callers converge on two frozen
 * combinations of the pacing and failure knobs, so those are captured here as
 * a single intent instead of four independent flags a caller can scramble.
 *
 * - `"chat"` — an interactive Chat turn. Tolerates a stream error (renders it
 *   inline), splits off a client stream branch, and stops yielding snapshots
 *   once the terminal finish has handed its folded messages over.
 * - `"delegate"` — an unattended, delegated sub-Agent. Gains the no-progress
 *   stop condition, fails when its stream reports an error (so the generated
 *   answer is never read as the finding), and yields every snapshot into the
 *   caller's activity log.
 */
export type StreamedDriveMode = "chat" | "delegate";

type DriveModeBehavior = {
  unattended: boolean;
  failOnStreamError: boolean;
  stopSnapshotsAfterFinal: boolean;
  returnResponse: boolean;
};

const MODE_BEHAVIOR: Record<StreamedDriveMode, DriveModeBehavior> = {
  chat: {
    unattended: false,
    failOnStreamError: false,
    stopSnapshotsAfterFinal: true,
    returnResponse: true,
  },
  delegate: {
    unattended: true,
    failOnStreamError: true,
    stopSnapshotsAfterFinal: false,
    returnResponse: false,
  },
};

/**
 * A streamed drive's inputs. `plan` carries the generation settings plus, for
 * a Chat turn, the folded conversation under `messages`; a delegated run hands
 * the conversation as a single `prompt` instead. The two are mutually
 * exclusive.
 */
export type StreamedDriveOptions = {
  plan: RunPlan;
  run: RunLifecycle;
  /** A single user prompt — the whole conversation of a delegated sub-Agent. */
  prompt?: string;
  /** A Chat turn's conversation, already converted to model messages. */
  modelMessages?: ModelMessage[];
  /** The opening messages a Chat turn folds its streamed answer onto. */
  originalMessages?: PlatypusUIMessage[];
  /** The resolved Agent id, stamped onto the streamed message. */
  agentId?: string;
  generateMessageId?: () => string;
  /** The live map the caller fills from `onToolExecutionEnd`. */
  toolDurations?: Map<string, number>;
  /**
   * Whether this is an interactive Chat turn or an unattended delegated
   * sub-Agent. Defaults to `"chat"`.
   */
  mode?: StreamedDriveMode;
  /** Hooked before the run folds the step, so the caller can read what it can't
   *  otherwise recover (e.g. the provider's raw finish reason). */
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

/** What a `driveStreamed` run settled on. */
export type StreamedDriveResult = {
  /** The Chat turn's final folded messages (tool durations applied). */
  messages?: PlatypusUIMessage[];
  /** The last snapshot seen — the delegate's final assistant message. */
  latest?: PlatypusUIMessage;
  /** Why a non-clean drive ended, in a caller-facing sentence. Absent for a
   *  clean finish. */
  failure?: string;
  /** The terminal finish hit the model's output ceiling. */
  truncated?: boolean;
};

type StreamedDrive = {
  /** The folded assistant messages. Consuming this is what drains the run. */
  snapshots: AsyncIterable<PlatypusUIMessage>;
  /** A client stream branch, present in `"chat"` mode (a Chat turn). */
  response?: ReadableStream<InferUIMessageChunk<PlatypusUIMessage>>;
  /** Resolves once the run has ended, with the drive's outcome. */
  done: Promise<StreamedDriveResult>;
};

/**
 * The one terminal-status rule, in a registered run's terms.
 *
 * Shared by both drivers so neither re-derives "did we succeed?" from the
 * stream or result it happened to be driving. Decides the status (and, where a
 * failure is reported, the caller-facing sentence) an ended run should carry:
 * a single no-progress trip or, on a fail-on-error drive, a stream failure
 * ends the run as a failure; a run somebody stopped ends it as cancelled; a
 * timeout stays a failure with its `TimeoutError`; anything else is a success.
 */
type TerminalDecision = {
  status: RunStatus;
  error?: Error;
  /** A caller-facing sentence for a non-clean end, when one is reported. */
  failure?: string;
};

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
  // A timed-out run keeps its TimeoutError rather than whichever stream error
  // also landed: the timeout names the bound that was exceeded.
  if (opts.failOnStreamError && opts.failure && status !== "failed") {
    const err = new Error(opts.failure);
    return {
      status: status === "cancelled" ? "cancelled" : "failed",
      error: status === "cancelled" ? (error ?? err) : err,
      failure: opts.failure,
    };
  }
  // A fail-on-error drive that stopped mid-stream reports why it stopped, so
  // the caller (a delegate's parent) can tell a stop from a finished answer.
  const failure =
    opts.failOnStreamError && run.handle.signal.aborted
      ? run.abortReason()
        ? `Stopped before finishing: ${run.abortReason()}`
        : "Stopped before finishing."
      : undefined;
  return { status, error, failure };
};

/**
 * Ends a streamed run with the terminal-status decision and the caller-facing
 * reason for a non-clean end, computed once. The run's status and the returned
 * outcome stay consistent by construction: the failure the caller is told is
 * exactly the one the run was finished with.
 */
const endStreamedRun = async (
  run: RunLifecycle,
  opts: {
    failure?: string;
    noProgress: NoProgressDetector | null;
    failOnStreamError: boolean;
  },
): Promise<TerminalDecision> => {
  const decision = decideTerminalStatus(run, opts);
  await run.finish(decision.status, decision.error);
  return decision;
};

/**
 * Drives a `streamText` run inside its registered lifecycle.
 *
 * Runs the model loop, folds the streamed parts into `PlatypusUIMessage`s
 * (metadata, tool durations, stream errors and the terminal finish handled
 * here), and records the terminal status exactly once. Returns a handle the
 * caller paces: its `snapshots` feed a Chat route's client stream or a
 * delegate's activity log, and `done` reports the outcome after the run has
 * been finished.
 */
export const driveStreamed = (opts: StreamedDriveOptions): StreamedDrive => {
  const {
    plan,
    run,
    prompt,
    modelMessages,
    originalMessages = [],
    agentId,
    generateMessageId,
    toolDurations,
    mode = "chat",
    onStepFinish,
    onToolExecutionEnd,
    onFinal,
  } = opts;

  const {
    unattended,
    failOnStreamError,
    stopSnapshotsAfterFinal,
    returnResponse,
  } = MODE_BEHAVIOR[mode];

  const noProgress: NoProgressDetector | null = unattended
    ? createNoProgressDetector()
    : null;

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
    ...buildModelInvocation(plan, {
      abortSignal: run.handle.signal,
      extraStopCondition: noProgress?.stopCondition,
    }),
    ...(prompt !== undefined ? { prompt } : { messages: modelMessages ?? [] }),
    onStepFinish: (step: RunStep) => {
      onStepFinish?.(step);
      run.onStep(step);
    },
    onToolExecutionEnd: (ctx) => {
      onToolExecutionEnd?.(ctx);
    },
  });

  const uiStream = result.toUIMessageStream<PlatypusUIMessage>({
    originalMessages,
    generateMessageId,
    messageMetadata: createMessageMetadata(agentId, toolDurations),
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

  let response:
    ReadableStream<InferUIMessageChunk<PlatypusUIMessage>> | undefined;
  let consume: ReadableStream<InferUIMessageChunk<PlatypusUIMessage>>;
  if (returnResponse) {
    const [client, snapshot] = uiStream.tee();
    response = client;
    consume = snapshot;
  } else {
    consume = uiStream;
  }

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
        if (stopSnapshotsAfterFinal && finalHandedOver) continue;
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
      // The failure and the terminal decision come from the same place, and only
      // that place — no caller re-derives "did it fail?" from the pieces here.
      const decision = await endStreamedRun(run, {
        failure,
        noProgress,
        failOnStreamError,
      });
      resolveDone({
        messages: handoverMessages,
        latest,
        failure: decision.failure,
        truncated,
      });
    }
  })();

  return {
    snapshots,
    response,
    done,
  };
};

export type OnceDriveOptions = {
  plan: RunPlan;
  run: RunLifecycle;
  prompt?: string;
  modelMessages?: ModelMessage[];
  /** Unattended (Trigger) runs enable no-progress detection. */
  unattended?: boolean;
};

/**
 * Drives a headless `generateText` run inside its registered lifecycle.
 *
 * Returns a single answer and the computed statistics. The terminal status and
 * output-ceiling cutoff are decided here — the same rules `driveStreamed`
 * applies — and the run is finished (succeeded, or failed with a `NoProgressError`
 * when the no-progress condition trips) before returning.
 */
export const driveOnce = async (
  opts: OnceDriveOptions,
): Promise<{ text: string; stats: RunStats }> => {
  const { plan, run, prompt, modelMessages, unattended = false } = opts;
  const noProgress: NoProgressDetector | null = unattended
    ? createNoProgressDetector()
    : null;
  const startTime = Date.now();

  try {
    const result = await generateText({
      ...buildModelInvocation(plan, {
        abortSignal: run.handle.signal,
        extraStopCondition: noProgress?.stopCondition,
      }),
      ...(prompt !== undefined
        ? { prompt }
        : { messages: modelMessages ?? [] }),
      onStepFinish: (step: RunStep) => run.onStep(step),
    });

    const stats = computeStats(result as Parameters<typeof computeStats>[0]);
    if (isTruncatedByTokenLimit(result.finishReason)) {
      stats.truncatedByTokenLimit = true;
    }
    run.setStats(stats);

    // The terminal decision is the same one `driveStreamed` ends its runs with.
    // The no-progress stop condition halts the loop cleanly (the SDK resolves
    // normally), so a tripped detector surfaces here rather than in the catch.
    const decision = decideTerminalStatus(run, {
      failure: undefined,
      noProgress,
      failOnStreamError: false,
    });
    const trip =
      decision.error instanceof NoProgressError
        ? { toolName: decision.error.toolName, count: decision.error.count }
        : null;

    // Nobody is watching an unattended run, so this log is the only record of
    // how it ended. Carried here because the completion log is the one place
    // the raw reason survives for an unattended run.
    if (trip) {
      logger.warn(
        {
          runId: run.handle.runId,
          toolName: trip.toolName,
          count: trip.count,
          duration: Date.now() - startTime,
          finishReason: result.finishReason,
          rawFinishReason: result.rawFinishReason,
          stats,
        },
        "Run aborted: no progress",
      );
    } else {
      logger.info(
        {
          runId: run.handle.runId,
          duration: Date.now() - startTime,
          responseLength: result.text.length,
          finishReason: result.finishReason,
          rawFinishReason: result.rawFinishReason,
          stats,
        },
        "Run generate completed",
      );
    }

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
      failure: undefined,
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
