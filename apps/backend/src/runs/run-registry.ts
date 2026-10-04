import { ConflictError } from "../errors.ts";
import type { RunId } from "./types.ts";

/**
 * In-memory, single-process registry of in-flight runs.
 *
 * Owns the AbortController per Run plus its per-step and per-run timeout
 * timers — the state that is truly per process. What the deployment shares
 * lives in Postgres (#1237): a Chat's one-run lock is its row's `running`
 * status (`ChatSink`), and a cancel reaches the process holding the Run
 * through `run-cancel.ts`. A runId claimed here is refused only within this
 * process.
 *
 * Cancellation is idempotent. Looking up an unknown runId returns
 * `false` / `undefined` without throwing.
 */
export class TimeoutError extends Error {
  readonly kind: "step" | "run";
  /** The bound that was exceeded, so a caller can say it without re-reading
   *  the configuration that set it. */
  readonly limitMs: number;

  constructor(message: string, kind: "step" | "run", limitMs: number) {
    super(message);
    this.name = "TimeoutError";
    this.kind = kind;
    this.limitMs = limitMs;
  }
}

/** A duration as a reader would say it: "90 seconds", "2 minutes". */
const humanizeMs = (ms: number): string => {
  const seconds = Math.round(ms / 1000);
  if (seconds < 120) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  const minutes = Math.round(seconds / 60);
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
};

/**
 * A timeout in the terms the person who was waiting understands.
 *
 * `TimeoutError.message` names the run id and a millisecond bound — right for a
 * log line, wrong for the one sentence a user gets when their answer stops
 * mid-word. Both timeouts are reported, because a user cannot tell them apart
 * from the outside and the remedy differs: a stalled provider versus a run that
 * was simply too long.
 */
export const describeTimeout = (error: TimeoutError): string =>
  error.kind === "step"
    ? `The model stopped sending output for ${humanizeMs(error.limitMs)}, so the run was stopped. Anything it had already written is kept above.`
    : `The run hit its ${humanizeMs(error.limitMs)} time limit and was stopped. Anything already written is kept above.`;

export type RegisterOptions = {
  /**
   * Idle timeout: how long the run may show no sign of life at all — no
   * streamed chunk, no step boundary, no tool-call edge — before it is
   * aborted. Not a ceiling on how long one step may take. Defaults to 2
   * minutes.
   */
  perStepTimeoutMs?: number;
  /** Wall-clock timeout for the whole run. Defaults to 10 minutes. */
  perRunTimeoutMs?: number;
  /**
   * Invoked when a per-step or per-run timeout fires. Receives a
   * `TimeoutError`. The registry has already aborted the controller before
   * calling this handler.
   */
  onTimeout?: (error: TimeoutError) => void;
};

/**
 * The two bounds a caller may set per run. Named because four call sites
 * across three modules pass exactly this pair.
 */
export type RunTimeouts = Pick<
  RegisterOptions,
  "perStepTimeoutMs" | "perRunTimeoutMs"
>;

export type RunHandle = {
  runId: RunId;
  signal: AbortSignal;
  /** Reset the per-step timer (e.g. when a step makes progress). */
  bumpStep(): void;
  /**
   * Record a sign of life from the model mid-step — one streamed chunk.
   *
   * The per-step bound is an IDLE timeout: "has the provider stopped talking to
   * us?", not "has this step taken too long?". Only `bumpStep` fires at step
   * boundaries, so without this a single step that streams for longer than the
   * bound is aborted while it is still producing output. That is what cut long
   * answers and long tool-call arguments off mid-stream (issue #552).
   *
   * Deliberately does not touch the timer. This is called once per streamed
   * chunk — thousands of times in a long answer — so it only stamps a
   * timestamp, and the timer re-arms itself from that stamp when it fires.
   */
  noteActivity(): void;
  /**
   * Suspend the per-step stall timer for the duration of a tool call.
   *
   * The per-step timeout answers "has anything happened lately?", and a tool
   * that is still executing produces no chunks to say so. Holds
   * nest, so parallel tool calls are counted; the timer re-arms when the last
   * one releases. The per-RUN timeout is deliberately untouched, so a tool that
   * never returns is still bounded.
   */
  holdStep(): void;
  /** Release a hold taken by {@link RunHandle.holdStep}. */
  releaseStep(): void;
};

export const DEFAULT_PER_STEP_TIMEOUT_MS = 2 * 60 * 1000;
export const DEFAULT_PER_RUN_TIMEOUT_MS = 10 * 60 * 1000;

type Entry = {
  controller: AbortController;
  perStepTimeoutMs: number;
  stepTimer?: ReturnType<typeof setTimeout>;
  runTimer?: ReturnType<typeof setTimeout>;
  onTimeout?: (error: TimeoutError) => void;
  finished: boolean;
  /** Tool calls currently in flight; the step timer is off while this is > 0. */
  holds: number;
  /** When this run last showed a sign of life — a step boundary, a tool-call
   *  edge, or a streamed chunk. The per-step bound is measured from here. */
  lastActivityAt: number;
};

export class RunRegistry {
  private readonly entries = new Map<RunId, Entry>();

  /**
   * Claims `runId` and returns its handle.
   *
   * A runId that is already claimed is a second run for something that already
   * has one — a Chat whose turn has not finished, since a Chat run's id IS the
   * chat id. Typed as a `ConflictError` so the central error handler answers
   * 409 (ADR-0010) instead of an unhandled throw becoming a 500, and so the
   * claim can be made the first thing a run does: registering before anything
   * is persisted is what stops a duplicate submission overwriting the live
   * run's messages on its way to failing (issue #648).
   */
  register(runId: RunId, options: RegisterOptions = {}): RunHandle {
    const existing = this.entries.get(runId);
    if (existing) {
      throw new ConflictError(`A run is already in progress for '${runId}'`);
    }

    const controller = new AbortController();
    const perStepTimeoutMs =
      options.perStepTimeoutMs ?? DEFAULT_PER_STEP_TIMEOUT_MS;
    const perRunTimeoutMs =
      options.perRunTimeoutMs ?? DEFAULT_PER_RUN_TIMEOUT_MS;

    const entry: Entry = {
      controller,
      perStepTimeoutMs,
      onTimeout: options.onTimeout,
      finished: false,
      holds: 0,
      lastActivityAt: Date.now(),
    };

    const fireTimeout = (kind: "step" | "run") => {
      if (entry.finished) return;
      // A step timer that wakes to find recent activity is not looking at a
      // stall: re-arm for the remainder of the idle window instead of aborting
      // a run that is still streaming. Re-arming here rather than on every
      // chunk keeps the hot path to one timestamp write.
      if (kind === "step") {
        const idleMs = Date.now() - entry.lastActivityAt;
        if (idleMs < entry.perStepTimeoutMs) {
          entry.stepTimer = setTimeout(
            () => fireTimeout("step"),
            entry.perStepTimeoutMs - idleMs,
          );
          return;
        }
      }
      entry.finished = true;
      const error = new TimeoutError(
        kind === "step"
          ? `Run '${runId}' exceeded per-step timeout of ${perStepTimeoutMs}ms`
          : `Run '${runId}' exceeded per-run timeout of ${perRunTimeoutMs}ms`,
        kind,
        kind === "step" ? perStepTimeoutMs : perRunTimeoutMs,
      );
      if (entry.stepTimer) clearTimeout(entry.stepTimer);
      if (entry.runTimer) clearTimeout(entry.runTimer);
      controller.abort(error);
      entry.onTimeout?.(error);
    };

    entry.stepTimer = setTimeout(() => fireTimeout("step"), perStepTimeoutMs);
    entry.runTimer = setTimeout(() => fireTimeout("run"), perRunTimeoutMs);

    this.entries.set(runId, entry);

    // Re-arm the per-step timer, unless a tool call is holding it down. Every
    // path that restarts the timer goes through here, so a hold cannot be
    // undone by a concurrent bump.
    const armStep = (e: Entry) => {
      if (e.stepTimer) clearTimeout(e.stepTimer);
      e.stepTimer = undefined;
      // Every path through here is itself a sign of life (a step finished, a
      // tool call started or returned), so the idle window restarts from now.
      e.lastActivityAt = Date.now();
      if (e.holds > 0) return;
      e.stepTimer = setTimeout(() => fireTimeout("step"), e.perStepTimeoutMs);
    };

    return {
      runId,
      signal: controller.signal,
      bumpStep: () => {
        const e = this.entries.get(runId);
        if (!e || e.finished) return;
        armStep(e);
      },
      noteActivity: () => {
        const e = this.entries.get(runId);
        if (!e || e.finished) return;
        e.lastActivityAt = Date.now();
      },
      holdStep: () => {
        const e = this.entries.get(runId);
        if (!e || e.finished) return;
        e.holds += 1;
        armStep(e);
      },
      releaseStep: () => {
        const e = this.entries.get(runId);
        if (!e || e.finished || e.holds === 0) return;
        e.holds -= 1;
        armStep(e);
      },
    };
  }

  /**
   * Cancel a run by id. Returns `true` if a run was cancelled, `false` if
   * the run was unknown or already finished. Repeated calls are safe.
   */
  cancel(runId: RunId): boolean {
    const entry = this.entries.get(runId);
    if (!entry || entry.finished) return false;
    entry.finished = true;
    if (entry.stepTimer) clearTimeout(entry.stepTimer);
    if (entry.runTimer) clearTimeout(entry.runTimer);
    entry.controller.abort(new Error(`Run '${runId}' cancelled`));
    return true;
  }

  /** Remove the entry once the run terminates. Always safe to call. */
  unregister(runId: RunId): void {
    const entry = this.entries.get(runId);
    if (!entry) return;
    entry.finished = true;
    if (entry.stepTimer) clearTimeout(entry.stepTimer);
    if (entry.runTimer) clearTimeout(entry.runTimer);
    this.entries.delete(runId);
  }

  has(runId: RunId): boolean {
    return this.entries.has(runId);
  }
}

/** Singleton — services and routes share one instance. */
export const runRegistry = new RunRegistry();
