import { describe, it, expect, afterEach } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import {
  applyMigration,
  migratedPglite,
} from "./migrated-pglite.test-fixtures.ts";

/**
 * Migration 0093 adds the `provider.workspace_id` FK, first removing the
 * Workspace Providers that past Organization and User deletes orphaned —
 * without that the FK could not be added.
 */
let pg: PGlite;
afterEach(() => pg.close());

describe("migration 0093_provider_workspace_fk", () => {
  it("removes orphaned Workspace Providers and keeps the rest", async () => {
    pg = await migratedPglite("0093_provider_workspace_fk");
    await pg.exec(`
      INSERT INTO "user" ("id", "name", "email", "email_verified", "created_at", "updated_at")
        VALUES ('u1', 'Jane', 'jane@example.com', true, now(), now());
      INSERT INTO "organization" ("id", "name") VALUES ('org-1', 'Acme');
      INSERT INTO "workspace" ("id", "organization_id", "owner_id", "name")
        VALUES ('ws-1', 'org-1', 'u1', 'Support');
      INSERT INTO "provider" ("id", "organization_id", "workspace_id", "name", "provider_type", "api_key", "task_model_id", "memory_extraction_model_id", "modelIds")
        VALUES ('shared-p', 'org-1', NULL, 'P', 'openai', 'k', 'm', 'm', '[]'),
               ('ws-p', NULL, 'ws-1', 'P', 'openai', 'k', 'm', 'm', '[]'),
               ('orphan-p', NULL, 'ws-gone', 'P', 'openai', 'k', 'm', 'm', '[]');
    `);

    await applyMigration(pg, "0093_provider_workspace_fk");

    const { rows } = await pg.query<{ id: string }>(
      `SELECT "id" FROM "provider" ORDER BY 1`,
    );
    expect(rows.map((r) => r.id)).toEqual(["shared-p", "ws-p"]);
  });
});
