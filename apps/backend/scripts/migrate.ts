import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import {
  ADVISORY_LOCK_IDS,
  withAdvisoryLock,
} from "../src/db/advisory-lock.ts";
import { databaseConfig } from "../src/db/connection-config.ts";
import { backfillTriggerNextRunAt } from "../src/db/backfill-trigger-next-run.ts";
import { databaseUrl } from "../src/env.ts";
import { logger } from "../src/logger.ts";

const { Pool } = pg;

const MIGRATIONS_FOLDER = fileURLToPath(new URL("../drizzle", import.meta.url));

async function runMigrations() {
  const pool = new Pool(databaseConfig(databaseUrl()));

  // why: an idle client dropped mid-migration would otherwise crash the process
  pool.on("error", (error) => {
    logger.error({ error }, "Idle database connection failed");
  });

  const db = drizzle(pool);

  try {
    await withAdvisoryLock(
      pool,
      ADVISORY_LOCK_IDS.migrations,
      async () => {
        logger.info("Running migrations...");

        await db.execute("CREATE EXTENSION IF NOT EXISTS vector");

        await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

        const { scheduled, skipped } = await backfillTriggerNextRunAt(db);
        if (scheduled > 0 || skipped > 0) {
          logger.info(
            { scheduled, skipped },
            "Rescheduled Cron Triggers left without a next run",
          );
        }
      },
      { wait: true },
    );
    logger.info("Migrations completed successfully!");
  } catch (error) {
    logger.error({ error }, "Migration failed");
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

void runMigrations();
