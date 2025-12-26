import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { logger } from "../src/logger.ts";

const { Pool } = pg;

async function runMigrations() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
  });

  const db = drizzle(pool);

  logger.info("Running migrations...");

  try {
    await migrate(db, { migrationsFolder: "./apps/backend/drizzle" });
    logger.info("Migrations completed successfully!");
  } catch (error) {
    logger.error({ error }, "Migration failed");
    process.exit(1);
  } finally {
    await pool.end();
  }
}

runMigrations();
