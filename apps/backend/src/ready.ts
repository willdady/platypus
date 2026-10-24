import { logger } from "./logger.ts";

/** How long `GET /ready` waits for the database before answering 503. */
export const DB_PING_TIMEOUT_MS = 2_000;

/** The slice of the Postgres pool a ping needs. */
export type Pingable = {
  query(query: { text: string; query_timeout?: number }): Promise<unknown>;
};

/**
 * One `SELECT 1` through the pool, bounded. A dead or unreachable database
 * answers a readiness probe "not ready" within its own patience instead of
 * after the pool's `statement_timeout` (10 minutes). `query_timeout` bounds
 * the statement itself (pg rejects it past that), and the `Promise.race`
 * bounds a pool `connect()` that never produces a client.
 */
export const pingDatabase = async (
  pool: Pingable,
  timeoutMs: number = DB_PING_TIMEOUT_MS,
): Promise<boolean> => {
  try {
    await Promise.race([
      pool.query({ text: "SELECT 1", query_timeout: timeoutMs }),
      new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(new Error(`SELECT 1 did not answer within ${timeoutMs}ms`)),
          timeoutMs,
        ),
      ),
    ]);
    return true;
  } catch (error) {
    logger.warn({ error }, "Readiness check: database did not answer");
    return false;
  }
};
