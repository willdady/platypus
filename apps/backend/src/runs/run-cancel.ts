import { z } from "zod";
import { logger } from "../logger.ts";
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

/**
 * The wire format of a cancel. Deliberately the whole of it: `cancelRun`
 * writes exactly these keys, so a payload carrying another — a field from a
 * version this instance does not know — is refused rather than half-read.
 */
const cancelSchema = z
  .object({
    runId: z.string().min(1),
    startedBefore: z.number().optional(),
  })
  .strict();

type Cancel = z.infer<typeof cancelSchema>;

/** The payload as JSON, or undefined when it does not parse. */
const readJson = (payload: string): unknown => {
  try {
    return JSON.parse(payload);
  } catch {
    return undefined;
  }
};

/**
 * A cancel as `cancelRun` sends it, or undefined for anything else. The
 * handler runs inside the listener's connection, so a payload it cannot read
 * is logged and dropped rather than thrown — one bad notification must not
 * take the channel down.
 */
const parseCancel = (payload: string): Cancel | undefined => {
  const result = cancelSchema.safeParse(readJson(payload));
  if (!result.success) {
    logger.warn(
      { payload, issues: result.error.issues },
      "Dropped a run_cancel payload in an unknown shape",
    );
    return undefined;
  }
  return result.data;
};

// A cancel sent while this instance's listener is down is missed; the run's
// own timeout still bounds it, and an A2A Task's cancel is also kept in the
// database for a sweep to find (`a2a-cancel.ts`).
onNotification(CHANNEL, (payload) => {
  const cancel = parseCancel(payload);
  if (!cancel) return;
  runRegistry.cancel(cancel.runId, { startedBefore: cancel.startedBefore });
});
