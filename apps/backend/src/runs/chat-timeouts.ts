/**
 * The bounds an interactive Chat run is given.
 *
 * Chat used to take the registry's own defaults, which are deliberately tight
 * because they are what an unbounded caller falls back to. That gave a watched
 * conversation a 10-minute ceiling — shorter than a long agentic turn — and no
 * way for an Operator to raise it (issue #552).
 *
 * The per-step bound is an idle timeout: time with no streamed chunk at all,
 * not time spent on one step. Two minutes of complete silence from a provider
 * is a stall worth acting on; a long answer is not, and no longer trips it.
 *
 * Override via env:
 *  - `CHAT_PER_STEP_TIMEOUT_MS` (default 2 min)
 *  - `CHAT_PER_RUN_TIMEOUT_MS` (default 30 min)
 *
 * Horizontal scaling: `CHAT_PER_RUN_TIMEOUT_MS` is read per process, and the
 * scheduler's stuck-Chat sweep derives its staleness cutoff from it (see
 * `jobs/scheduler.ts`). Every instance sharing a database MUST be given the
 * same value — an instance configured with a shorter one computes an earlier
 * cutoff and could fail a turn a peer is still running.
 */
export const DEFAULT_CHAT_PER_STEP_TIMEOUT_MS = 2 * 60 * 1000;
export const DEFAULT_CHAT_PER_RUN_TIMEOUT_MS = 30 * 60 * 1000;

/** The configured wall-clock ceiling for a whole Chat turn. */
export const chatPerRunTimeoutMs = (): number =>
  parseInt(
    process.env.CHAT_PER_RUN_TIMEOUT_MS ??
      String(DEFAULT_CHAT_PER_RUN_TIMEOUT_MS),
  );

/** The per-step and per-run bounds handed to the run registry for a Chat turn. */
export const chatTimeouts = () => ({
  perStepTimeoutMs: parseInt(
    process.env.CHAT_PER_STEP_TIMEOUT_MS ??
      String(DEFAULT_CHAT_PER_STEP_TIMEOUT_MS),
  ),
  perRunTimeoutMs: chatPerRunTimeoutMs(),
});
