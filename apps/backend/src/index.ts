import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { databaseConfig } from "./db/connection-config.ts";
import { env } from "./env.ts";
import { logger } from "./logger.ts";

/** How long a query waits for a free connection before it fails. */
const CONNECTION_TIMEOUT_MS = 10_000;
/** The longest any one statement may run; nothing the backend sends nears it. */
const STATEMENT_TIMEOUT_MS = 60_000;
/** How long a transaction may sit idle before Postgres ends its session. */
const IDLE_IN_TRANSACTION_TIMEOUT_MS = 60_000;

const pool = new pg.Pool({
  ...databaseConfig(env().DATABASE_URL),
  max: env().DATABASE_POOL_MAX,
  connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
  statement_timeout: STATEMENT_TIMEOUT_MS,
  idle_in_transaction_session_timeout: IDLE_IN_TRANSACTION_TIMEOUT_MS,
});

// An idle client dropped by a Postgres restart or failover emits `error`;
// unhandled, that would crash the process. The pool replaces the client on
// the next checkout.
pool.on("error", (err) => {
  logger.error({ err }, "Idle database connection failed");
});

const db = drizzle({ client: pool });

/** A transaction `db.transaction` hands its callback. */
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Either `db` or a transaction, for a helper that can run as one step of a
 * larger write.
 */
export type Executor = typeof db | Tx;

export { db };
