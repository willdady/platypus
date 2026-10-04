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

/** Aborts `runId` here if this instance holds it, else asks the others to. */
export const cancelRun = async (runId: RunId): Promise<void> => {
  if (runRegistry.cancel(runId)) return;
  await db.$client.query("SELECT pg_notify($1, $2)", [CHANNEL, runId]);
};

/**
 * Holds one connection LISTENing for cancels, reconnecting when it drops. A
 * cancel sent while it is down is missed; the run's own timeout still bounds
 * it.
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
      if (channel === CHANNEL && payload) runRegistry.cancel(payload);
    });
    await client.query(`LISTEN ${CHANNEL}`);
  } catch (err) {
    reconnect(err);
  }
};
