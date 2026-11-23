import { logger } from "./logger.ts";

export const DB_PING_TIMEOUT_MS = 2_000;

export type Pingable = {
  query(query: { text: string; query_timeout?: number }): Promise<unknown>;
};

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
