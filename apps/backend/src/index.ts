import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { buildPoolConfig } from "./db/connection-config.ts";
import { env } from "./env.ts";
import { logger } from "./logger.ts";

/**
 * The one Postgres pool of the process. Explicit, so no connection is opened
 * on pg's or node-postgres' implicit defaults: the size comes from the
 * Operator, the guards (`connectionTimeoutMillis`, `statement_timeout`,
 * `idle_in_transaction_session_timeout`) free a connection a stuck session
 * would otherwise squat, and the `error` listener keeps an idle client dropped
 * by a Postgres restart or failover a log line instead of an unhandled 'error'
 * event that crashes the process mid-flight (#1616) — the same listener
 * `scripts/migrate.ts` already has for the same reason.
 */
export const pool = new Pool(
  buildPoolConfig(env().DATABASE_URL, env().DATABASE_POOL_MAX),
);
pool.on("error", (error) => {
  logger.error({ error }, "Idle database connection failed");
});

export const db = drizzle(pool);

/** A transaction `db.transaction` hands its callback. */
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Either `db` or a transaction, for a helper that can run as one step of a
 * larger write.
 */
export type Executor = typeof db | Tx;
