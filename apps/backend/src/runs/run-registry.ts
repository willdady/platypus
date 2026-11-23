import { ConflictError, ServiceUnavailableError } from "../errors.ts";
import type { RunId } from "./types.ts";

export class TimeoutError extends Error {
  readonly kind: "step" | "run";
  readonly limitMs: number;

  constructor(message: string, kind: "step" | "run", limitMs: number) {
    super(message);
    this.name = "TimeoutError";
    this.kind = kind;
    this.limitMs = limitMs;
  }
}

const humanizeMs = (ms: number): string => {
  const seconds = Math.round(ms / 1000);
  if (seconds < 120) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  const minutes = Math.round(seconds / 60);
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
};

export const describeTimeout = (error: TimeoutError): string =>
  error.kind === "step"
    ? `The model stopped sending output for ${humanizeMs(error.limitMs)}, so the run was stopped. Anything it had already written is kept above.`
    : `The run hit its ${humanizeMs(error.limitMs)} time limit and was stopped. Anything already written is kept above.`;

export type RegisterOptions = {
  perStepTimeoutMs?: number;
  perRunTimeoutMs?: number;
  onTimeout?: (error: TimeoutError) => void;
};

export type RunTimeouts = Pick<
  RegisterOptions,
  "perStepTimeoutMs" | "perRunTimeoutMs"
>;

export type RunHandle = {
  runId: RunId;
  signal: AbortSignal;
  bumpStep(): void;
  noteActivity(): void;
  holdStep(): void;
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
  holds: number;
  lastActivityAt: number;
  startedAt: number;
};

export type CancelOptions = {
  startedBefore?: number;
};

export class RunRegistry {
  private readonly entries = new Map<RunId, Entry>();
  private readonly idleWaiters = new Set<() => void>();
  private stopRequested = false;

  beginStop(): void {
    this.stopRequested = true;
  }

  get stopping(): boolean {
    return this.stopRequested;
  }

  resetStopStateForTests(): void {
    this.stopRequested = false;
  }

  register(runId: RunId, options: RegisterOptions = {}): RunHandle {
    if (this.stopping) {
      throw new ServiceUnavailableError("Server is shutting down");
    }
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
      startedAt: Date.now(),
    };

    const fireTimeout = (kind: "step" | "run") => {
      if (entry.finished) return;
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

    const armStep = (e: Entry) => {
      if (e.stepTimer) clearTimeout(e.stepTimer);
      e.stepTimer = undefined;
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
        // why: runs once per streamed chunk; stamp only, the step timer re-arms from the stamp
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

  cancel(runId: RunId, options: CancelOptions = {}): boolean {
    const entry = this.entries.get(runId);
    if (!entry || entry.finished) return false;
    if (
      options.startedBefore !== undefined &&
      entry.startedAt > options.startedBefore
    ) {
      return false;
    }
    entry.finished = true;
    if (entry.stepTimer) clearTimeout(entry.stepTimer);
    if (entry.runTimer) clearTimeout(entry.runTimer);
    entry.controller.abort(new Error(`Run '${runId}' cancelled`));
    return true;
  }

  unregister(runId: RunId): void {
    const entry = this.entries.get(runId);
    if (!entry) return;
    entry.finished = true;
    if (entry.stepTimer) clearTimeout(entry.stepTimer);
    if (entry.runTimer) clearTimeout(entry.runTimer);
    this.entries.delete(runId);
    if (this.entries.size === 0) {
      for (const wake of [...this.idleWaiters]) wake();
    }
  }

  whenIdle(timeoutMs: number): Promise<boolean> {
    if (this.entries.size === 0) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = (idle: boolean) => {
        clearTimeout(timer);
        this.idleWaiters.delete(wake);
        resolve(idle);
      };
      const wake = () => done(true);
      const timer = setTimeout(() => done(false), timeoutMs);
      this.idleWaiters.add(wake);
    });
  }

  heldRuns(): { runId: RunId; startedAt: number }[] {
    return [...this.entries]
      .filter(([, entry]) => !entry.finished)
      .map(([runId, entry]) => ({ runId, startedAt: entry.startedAt }));
  }

  has(runId: RunId): boolean {
    return this.entries.has(runId);
  }
}

export const runRegistry = new RunRegistry();
