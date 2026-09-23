/**
 * The bounds an unattended Trigger run is given.
 *
 * Headless runs aren't user-facing, so there is no UX reason for the registry's
 * own tight defaults. Crons are allowed to do substantial work (multi-step
 * research, long MCP searches); the defaults aim to bound runaway runs without
 * tripping on legitimate workloads.
 *
 * Override via env:
 *  - `TRIGGER_PER_STEP_TIMEOUT_MS` (default 10 min)
 *  - `TRIGGER_PER_RUN_TIMEOUT_MS` (default 60 min)
 *
 * Horizontal scaling: `TRIGGER_PER_RUN_TIMEOUT_MS` is read per process, and the
 * scheduler's stuck-Trigger sweep derives its staleness cutoff from it (see
 * `jobs/scheduler.ts`). Every instance sharing a database MUST be given the
 * same value — an instance configured with a shorter one computes an earlier
 * cutoff and could fail a run a peer is still driving.
 */
const DEFAULT_TRIGGER_PER_STEP_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_TRIGGER_PER_RUN_TIMEOUT_MS = 60 * 60 * 1000;

/** The configured wall-clock ceiling for a whole Trigger run. */
export const triggerPerRunTimeoutMs = (): number =>
  Number(process.env.TRIGGER_PER_RUN_TIMEOUT_MS) ||
  DEFAULT_TRIGGER_PER_RUN_TIMEOUT_MS;

/** The per-step and per-run bounds handed to the run registry for a Trigger run. */
export const triggerTimeouts = () => ({
  perStepTimeoutMs:
    Number(process.env.TRIGGER_PER_STEP_TIMEOUT_MS) ||
    DEFAULT_TRIGGER_PER_STEP_TIMEOUT_MS,
  perRunTimeoutMs: triggerPerRunTimeoutMs(),
});
