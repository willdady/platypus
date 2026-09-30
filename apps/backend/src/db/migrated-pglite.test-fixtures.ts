import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

/**
 * Test support: an in-process Postgres built from the shipped migrations, so a
 * test can lean on the constraints production actually has.
 */
const drizzleDir = new URL("../../drizzle/", import.meta.url);
const tags = (
  JSON.parse(
    readFileSync(new URL("meta/_journal.json", drizzleDir), "utf8"),
  ) as { entries: { tag: string }[] }
).entries.map((e) => e.tag);

/** Applies one migration file, statement by statement. */
export const applyMigration = async (pg: PGlite, tag: string) => {
  const sql = readFileSync(new URL(`${tag}.sql`, drizzleDir), "utf8");
  for (const statement of sql.split("--> statement-breakpoint")) {
    await pg.exec(statement);
  }
};

/**
 * Boots a PGlite and applies every migration in journal order, stopping before
 * `until` when given so a test can seed data the next migration must handle.
 */
export const migratedPglite = async (until?: string): Promise<PGlite> => {
  const pg = await PGlite.create();
  // pgvector is not bundled with PGlite; the migrations only name the type.
  await pg.exec("CREATE DOMAIN vector AS real[]");
  for (const tag of tags) {
    if (tag === until) break;
    await applyMigration(pg, tag);
  }
  return pg;
};
