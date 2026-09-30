import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import {
  applyMigration,
  migratedPglite,
} from "./migrated-pglite.test-fixtures.ts";

/**
 * One global Context per user and one membership per Organization (#1130),
 * run for real: duplicates the old constraints let through are seeded, then
 * the migration that closes the gap is applied over them.
 */
const MIGRATION = "0076_unique_context_and_org_member";

let pg: PGlite;
beforeAll(async () => {
  pg = await migratedPglite(MIGRATION);
  await pg.exec(`
    INSERT INTO "user" ("id", "name", "email", "email_verified", "created_at", "updated_at")
      VALUES ('u1', 'Jane', 'jane@example.com', true, now(), now());
    INSERT INTO "organization" ("id", "name") VALUES ('org-1', 'Acme');
    INSERT INTO "context" ("id", "user_id", "workspace_id", "content", "created_at")
      VALUES ('ctx-newer', 'u1', NULL, 'newer', '2026-02-01'),
             ('ctx-oldest', 'u1', NULL, 'oldest', '2026-01-01'),
             ('ctx-newest', 'u1', NULL, 'newest', '2026-03-01');
    INSERT INTO "organization_member" ("id", "organization_id", "user_id", "role", "created_at")
      VALUES ('m-newer', 'org-1', 'u1', 'member', '2026-02-01'),
             ('m-oldest', 'org-1', 'u1', 'admin', '2026-01-01');
  `);
  await applyMigration(pg, MIGRATION);
}, 60_000);
afterAll(() => pg.close());

const ids = async (table: string) =>
  (
    await pg.query<{ id: string }>(`SELECT "id" FROM "${table}" ORDER BY "id"`)
  ).rows.map((r) => r.id);

const sqlstateOf = (sql: string) =>
  pg.query(sql).then(
    () => undefined,
    (e: { code?: string }) => e.code,
  );

describe(MIGRATION, () => {
  it("keeps only each user's oldest global Context", async () => {
    expect(await ids("context")).toEqual(["ctx-oldest"]);
  });

  it("keeps only the oldest membership of an Organization", async () => {
    expect(await ids("organization_member")).toEqual(["m-oldest"]);
  });

  it("refuses a second global Context for the same user", async () => {
    expect(
      await sqlstateOf(
        `INSERT INTO "context" ("id", "user_id", "workspace_id", "content")
           VALUES ('ctx-again', 'u1', NULL, 'again')`,
      ),
    ).toBe("23505");
  });

  it("refuses a second membership of the same Organization", async () => {
    expect(
      await sqlstateOf(
        `INSERT INTO "organization_member" ("id", "organization_id", "user_id")
           VALUES ('m-again', 'org-1', 'u1')`,
      ),
    ).toBe("23505");
  });
});
