import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

/**
 * 0101 refuses a Provider row the earlier backfills did not resolve, so the
 * backend never reads a `modelIds` shape its schema no longer has.
 */
const migration = readFileSync(
  new URL("../../drizzle/0101_assert_model_configs.sql", import.meta.url),
  "utf8",
);

let db: PGlite;
beforeAll(async () => {
  db = await PGlite.create();
}, 60_000);
afterAll(() => db.close());

const run = async (modelIds: unknown[]) => {
  await db.exec(`
    DROP SCHEMA public CASCADE;
    CREATE SCHEMA public;
    CREATE TABLE "provider" ("id" text PRIMARY KEY, "modelIds" jsonb NOT NULL);
  `);
  await db.query(`INSERT INTO "provider" VALUES ($1, $2)`, [
    "p1",
    JSON.stringify(modelIds),
  ]);
  await db.exec(migration);
};

describe("0101 model-config assertion", () => {
  it("passes resolved objects and an empty list", async () => {
    await expect(
      run([{ id: "gpt-4", passthroughFileTypes: [] }]),
    ).resolves.toBeUndefined();
    await expect(run([])).resolves.toBeUndefined();
  });

  it("refuses a bare string entry", async () => {
    await expect(run(["gpt-4"])).rejects.toThrow(/for provider\(s\) p1;/);
  });

  it("refuses an object the earlier backfill never completed", async () => {
    await expect(run([{ id: "gpt-4" }])).rejects.toThrow(/not resolved/);
  });
});
