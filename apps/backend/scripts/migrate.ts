import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import {
  ADVISORY_LOCK_IDS,
  withAdvisoryLock,
} from "../src/db/advisory-lock.ts";
import { logger } from "../src/logger.ts";

const { Pool } = pg;

// Resolved from this file rather than the cwd, so the script works whether it
// is run from the repo root (as the image does) or from `apps/backend`.
const MIGRATIONS_FOLDER = fileURLToPath(new URL("../drizzle", import.meta.url));

async function runMigrations() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
  });

  // An idle client dropped mid-migration (e.g. the one holding the lock) would
  // otherwise crash the process with an unhandled 'error' event.
  pool.on("error", (error) => {
    logger.error({ error }, "Idle database connection failed");
  });

  const db = drizzle(pool);

  try {
    // Replicas starting together each run this script; the lock makes them
    // take turns, and each one after the first finds nothing left to apply.
    await withAdvisoryLock(pool, ADVISORY_LOCK_IDS.migrations, async () => {
      logger.info("Running migrations...");

      // Enable pgvector extension before running schema migrations
      await db.execute("CREATE EXTENSION IF NOT EXISTS vector");

      await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    });
    logger.info("Migrations completed successfully!");
  } catch (error) {
    logger.error({ error }, "Migration failed");
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

void runMigrations();
