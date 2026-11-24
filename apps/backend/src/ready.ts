import { Hono } from "hono";
import { logger } from "./logger.ts";
import { runRegistry, type RunRegistry } from "./runs/run-registry.ts";

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

export const readyRoutes = (
  pool: Pingable,
  registry: RunRegistry = runRegistry,
): Hono => {
  const app = new Hono();
  app.get("/ready", async (c) => {
    if (registry.stopping) {
      return c.json({ error: "Server is shutting down" }, 503);
    }
    const ready = await pingDatabase(pool);
    return ready
      ? c.json({ status: "ready" })
      : c.json({ error: "Database unavailable" }, 503);
  });
  return app;
};
