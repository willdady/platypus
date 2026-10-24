import { drizzle } from "drizzle-orm/node-postgres";
import { databaseConfig } from "./db/connection-config.ts";
import { env } from "./env.ts";

const db = drizzle({ connection: databaseConfig(env().DATABASE_URL) });

/** A transaction `db.transaction` hands its callback. */
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Either `db` or a transaction, for a helper that can run as one step of a
 * larger write.
 */
export type Executor = typeof db | Tx;

export { db };
