import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

const MIGRATIONS_FOLDER = fileURLToPath(
  new URL("../../drizzle/", import.meta.url),
);

const LABEL = /^[a-z][a-z0-9_]*$/;

export type ScratchPostgres = {
  url: string;
  drop: () => Promise<void>;
};

const baseUrl = (): string => {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "A real-Postgres test needs DATABASE_URL pointing at a server it may create a scratch database on",
    );
  }
  return url;
};

const scratchDatabase = (url: string, label: string) => {
  if (!LABEL.test(label)) {
    throw new Error(`Scratch database label must match ${LABEL}: ${label}`);
  }
  return `${new URL(url).pathname.slice(1)}_${label}_scratch`;
};

const urlFor = (url: string, database: string) => {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
};

const run = async (url: string, sql: string) => {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
};

// why: the guard's row lock is invisible on a single-connection PGlite, so a real server is required
export const createScratchPostgres = async (
  label: string,
): Promise<ScratchPostgres> => {
  const server = baseUrl();
  const database = scratchDatabase(server, label);
  const url = urlFor(server, database);
  const drop = () =>
    run(server, `DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);

  try {
    await drop();
    await run(server, `CREATE DATABASE "${database}"`);
    // why: the migrations only name the type, as the migration script does
    await run(url, "CREATE EXTENSION IF NOT EXISTS vector");

    const pool = new pg.Pool({ connectionString: url });
    try {
      await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS_FOLDER });
    } finally {
      await pool.end();
    }
  } catch (error) {
    await drop();
    throw error;
  }

  return { url, drop };
};
