import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import {
  applyMigration,
  migratedPglite,
} from "./migrated-pglite.test-fixtures.ts";

/**
 * Chats no longer carry tags (#1873): the migration drops the column outright,
 * since the API is not public and the tags were model-generated.
 */
const MIGRATION = "0104_drop_chat_tags";

let pg: PGlite;
beforeAll(async () => {
  pg = await migratedPglite(MIGRATION);
  await pg.exec(`
    INSERT INTO "user" ("id", "name", "email") VALUES ('u1', 'Jane', 'jane@example.com');
    INSERT INTO "organization" ("id", "name") VALUES ('org-1', 'Acme');
    INSERT INTO "workspace" ("id", "organization_id", "owner_id", "name")
      VALUES ('ws-1', 'org-1', 'u1', 'Support');
    INSERT INTO "chat" ("id", "workspace_id", "title", "tags")
      VALUES ('chat-1', 'ws-1', 'Kept', '["ops", "digest"]'::jsonb);
  `);
  await applyMigration(pg, MIGRATION);
}, 120_000);
afterAll(() => pg.close());

describe(MIGRATION, () => {
  it("drops the chat tags column", async () => {
    const { rows } = await pg.query<{ column_name: string }>(
      `SELECT "column_name" FROM information_schema.columns
         WHERE "table_name" = 'chat' AND "column_name" = 'tags'`,
    );
    expect(rows).toEqual([]);
  });

  it("keeps the Chat row and its title", async () => {
    const { rows } = await pg.query<{ id: string; title: string }>(
      `SELECT "id", "title" FROM "chat" WHERE "id" = 'chat-1'`,
    );
    expect(rows).toEqual([{ id: "chat-1", title: "Kept" }]);
  });
});
