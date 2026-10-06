import { notify, onNotification } from "./notify-listener.ts";
import { runRegistry } from "./run-registry.ts";
import type { RunId } from "./types.ts";

/**
 * Cancel across backend instances (#1237). A run's AbortController lives in
 * the one process running it, so a cancel received anywhere else is passed on
 * through Postgres: every instance LISTENs (`notify-listener.ts`), and the one
 * holding the run aborts it.
 */
const CHANNEL = "run_cancel";

/**
 * Aborts `runId` here if this instance holds it, else asks the others to.
 * With `startedBefore`, only a run claimed before that moment is aborted, so
 * a cancel meant for one turn never stops the Chat's next one.
 */
export const cancelRun = async (
  runId: RunId,
  { startedBefore }: { startedBefore?: Date } = {},
): Promise<void> => {
  const options = { startedBefore: startedBefore?.getTime() };
  if (runRegistry.cancel(runId, options)) return;
  // A bare id, as every instance has always read one, unless narrowed.
  const payload = startedBefore ? JSON.stringify({ runId, ...options }) : runId;
  await notify(CHANNEL, payload);
};

/** A cancel as `cancelRun` sends it. */
const parseCancel = (
  payload: string,
): { runId: RunId; startedBefore?: number } =>
  payload.startsWith("{")
    ? (JSON.parse(payload) as { runId: RunId; startedBefore?: number })
    : { runId: payload };

// A cancel sent while this instance's listener is down is missed; the run's
// own timeout still bounds it, and an A2A Task's cancel is also kept in the
// database for a sweep to find (`a2a-cancel.ts`).
onNotification(CHANNEL, (payload) => {
  const { runId, startedBefore } = parseCancel(payload);
  runRegistry.cancel(runId, { startedBefore });
});
