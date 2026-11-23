import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { buildPoolConfig } from "./db/connection-config.ts";
import { env } from "./env.ts";
import { logger } from "./logger.ts";

export const pool = new Pool(
  buildPoolConfig(env().DATABASE_URL, env().DATABASE_POOL_MAX),
);
// why: an idle client dropped by a Postgres restart would otherwise crash the process
pool.on("error", (error) => {
  logger.error({ error }, "Idle database connection failed");
});

export const db = drizzle(pool);

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type Executor = typeof db | Tx;
