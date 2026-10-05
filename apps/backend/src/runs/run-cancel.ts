import type { PoolClient } from "pg";
import { db } from "../index.ts";
import { logger } from "../logger.ts";
import { runRegistry } from "./run-registry.ts";
import type { RunId } from "./types.ts";

/**
 * Cancel across backend instances (#1237). A run's AbortController lives in
 * the one process running it, so a cancel received anywhere else is passed on
 * through Postgres: every instance LISTENs, and the one holding the run aborts
 * it.
 */
const CHANNEL = "run_cancel";
const RECONNECT_MS = 5_000;

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
  await db.$client.query("SELECT pg_notify($1, $2)", [CHANNEL, payload]);
};

/** A cancel as `cancelRun` sends it. */
const parseCancel = (
  payload: string,
): { runId: RunId; startedBefore?: number } =>
  payload.startsWith("{")
    ? (JSON.parse(payload) as { runId: RunId; startedBefore?: number })
    : { runId: payload };

/**
 * Holds one connection LISTENing for cancels, reconnecting when it drops. A
 * cancel sent while it is down is missed; the run's own timeout still bounds
 * it, and an A2A Task's cancel is also kept in the database for a sweep to
 * find (`a2a-cancel.ts`).
 *
 * ponytail: reconnects only on a connection `error`; a silently half-open
 * socket stays deaf until the run times out. Add a periodic heartbeat query if
 * that bites.
 */
export const listenForRunCancels = (): void => {
  void listen();
};

const listen = async (): Promise<void> => {
  let client: PoolClient | undefined;
  let lost = false;
  const reconnect = (err: unknown) => {
    if (lost) return;
    lost = true;
    logger.error({ err }, "Run cancel listener lost its connection");
    client?.release(err instanceof Error ? err : true);
    setTimeout(() => void listen(), RECONNECT_MS);
  };
  try {
    client = await db.$client.connect();
    client.on("error", reconnect);
    client.on("notification", ({ channel, payload }) => {
      if (channel !== CHANNEL || !payload) return;
      const { runId, startedBefore } = parseCancel(payload);
      runRegistry.cancel(runId, { startedBefore });
    });
    await client.query(`LISTEN ${CHANNEL}`);
  } catch (err) {
    reconnect(err);
  }
};
