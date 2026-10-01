import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { migratedPglite } from "./migrated-pglite.test-fixtures.ts";

/**
 * A parent delete has to find its referencing rows to cascade, set null or
 * restrict, and without an index on the referencing columns that is a scan of
 * the whole child table per deleted parent (#1139). Pinned against the shipped
 * migrations, so a new unindexed foreign key fails here rather than in a slow
 * production delete.
 */
let pg: PGlite;
beforeAll(async () => {
  pg = await migratedPglite();
}, 60_000);
afterAll(() => pg.close());

describe("foreign keys", () => {
  it("are each covered by an index leading with their columns", async () => {
    const { rows } = await pg.query<{ constraint: string }>(`
      SELECT c.conrelid::regclass || '.' || c.conname AS "constraint"
      FROM pg_constraint c
      WHERE c.contype = 'f'
        AND c.connamespace = 'public'::regnamespace
        AND NOT EXISTS (
          SELECT 1 FROM pg_index i
          WHERE i.indrelid = c.conrelid
            AND (
              -- Leads with exactly the key's columns, in any order.
              (
                (i.indkey::int2[])[0:cardinality(c.conkey) - 1] @> c.conkey
                AND (i.indkey::int2[])[0:cardinality(c.conkey) - 1] <@ c.conkey
              )
              -- Or is unique on a subset of them, so at most one row matches.
              OR (i.indisunique AND i.indkey::int2[] <@ c.conkey)
            )
        )
      ORDER BY 1
    `);
    expect(rows.map((r) => r.constraint)).toEqual([]);
  });
});

describe("invitation.invited_by", () => {
  it("lets a user who sent an invitation be deleted, keeping the invitation", async () => {
    await pg.exec(`
      INSERT INTO "user" ("id", "name", "email", "email_verified", "created_at", "updated_at")
        VALUES ('inviter', 'Admin', 'admin@example.com', true, now(), now());
      INSERT INTO "organization" ("id", "name") VALUES ('org-1', 'Acme');
      INSERT INTO "invitation" ("id", "email", "organization_id", "invited_by", "expires_at")
        VALUES ('inv-1', 'jane@example.com', 'org-1', 'inviter', now() + interval '7 days');
      DELETE FROM "user" WHERE "id" = 'inviter';
    `);
    const { rows } = await pg.query<{ invited_by: string | null }>(
      `SELECT "invited_by" FROM "invitation" WHERE "id" = 'inv-1'`,
    );
    expect(rows).toEqual([{ invited_by: null }]);
  });
});
