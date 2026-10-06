import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";

const drizzleDir = new URL("../../drizzle/", import.meta.url);
const journal = JSON.parse(
  readFileSync(new URL("meta/_journal.json", drizzleDir), "utf8"),
) as { entries: { tag: string }[] };

/**
 * A fresh database goes through Drizzle's own migrator, as
 * `scripts/migrate.ts` runs it in production: journal, hashes and all, not
 * the statement-by-statement replay the other PGlite tests lean on.
 */
describe("the shipped migrations", () => {
  it("apply cleanly to a fresh database", async () => {
    const pg = await PGlite.create();
    try {
      // pgvector is not bundled with PGlite; the migrations only name the type.
      await pg.exec("CREATE DOMAIN vector AS real[]");

      await migrate(drizzle(pg), {
        migrationsFolder: fileURLToPath(drizzleDir),
      });

      const { rows } = await pg.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM "drizzle"."__drizzle_migrations"`,
      );
      expect(rows[0].count).toBe(journal.entries.length);
    } finally {
      await pg.close();
    }
  }, 60_000);
});
