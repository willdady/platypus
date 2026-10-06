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
  await notify(CHANNEL, JSON.stringify({ runId, ...options }));
};

type Cancel = { runId: RunId; startedBefore?: number };

/**
 * A cancel as `cancelRun` sends it, or undefined for anything else: the
 * handler runs inside the listener's connection, so a payload it cannot read
 * is dropped rather than thrown.
 */
const parseCancel = (payload: string): Cancel | undefined => {
  try {
    const cancel = JSON.parse(payload) as Partial<Cancel> | null;
    return typeof cancel?.runId === "string" ? (cancel as Cancel) : undefined;
  } catch {
    return undefined;
  }
};

// A cancel sent while this instance's listener is down is missed; the run's
// own timeout still bounds it, and an A2A Task's cancel is also kept in the
// database for a sweep to find (`a2a-cancel.ts`).
onNotification(CHANNEL, (payload) => {
  const cancel = parseCancel(payload);
  if (!cancel) return;
  runRegistry.cancel(cancel.runId, { startedBefore: cancel.startedBefore });
});
