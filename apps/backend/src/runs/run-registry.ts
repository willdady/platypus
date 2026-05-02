import type { RunId } from "./types.ts";

/**
 * In-memory, single-process registry of in-flight runs.
 *
 * Owns the AbortController per Run plus its per-step and per-run timeout
 * timers. Cancellation works only when reaching the same process holding the
 * Run; if the deployment topology ever becomes multi-process, this module
 * is the first thing to revisit.
 *
 * Cancellation is idempotent. Looking up an unknown runId returns
 * `false` / `undefined` without throwing.
 */
export class TimeoutError extends Error {
  readonly kind: "step" | "run";

  constructor(message: string, kind: "step" | "run") {
    super(message);
    this.name = "TimeoutError";
    this.kind = kind;
  }
}

export type RegisterOptions = {
  /** Per-step (between-step) idle timeout. Defaults to 2 minutes. */
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

export type RunHandle = {
  runId: RunId;
  signal: AbortSignal;
  /** Reset the per-step timer (e.g. when a step makes progress). */
  bumpStep(): void;
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
};

export class RunRegistry {
  private readonly entries = new Map<RunId, Entry>();

  register(runId: RunId, options: RegisterOptions = {}): RunHandle {
    const existing = this.entries.get(runId);
    if (existing) {
      throw new Error(`RunRegistry: run '${runId}' already registered`);
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
    };

    const fireTimeout = (kind: "step" | "run") => {
      if (entry.finished) return;
      entry.finished = true;
      const error = new TimeoutError(
        kind === "step"
          ? `Run '${runId}' exceeded per-step timeout of ${perStepTimeoutMs}ms`
          : `Run '${runId}' exceeded per-run timeout of ${perRunTimeoutMs}ms`,
        kind,
      );
      if (entry.stepTimer) clearTimeout(entry.stepTimer);
      if (entry.runTimer) clearTimeout(entry.runTimer);
      controller.abort(error);
      entry.onTimeout?.(error);
    };

    entry.stepTimer = setTimeout(() => fireTimeout("step"), perStepTimeoutMs);
    entry.runTimer = setTimeout(() => fireTimeout("run"), perRunTimeoutMs);

    this.entries.set(runId, entry);

    return {
      runId,
      signal: controller.signal,
      bumpStep: () => {
        const e = this.entries.get(runId);
        if (!e || e.finished) return;
        if (e.stepTimer) clearTimeout(e.stepTimer);
        e.stepTimer = setTimeout(() => fireTimeout("step"), e.perStepTimeoutMs);
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
