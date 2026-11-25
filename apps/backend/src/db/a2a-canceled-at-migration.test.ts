import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import {
  applyMigration,
  migratedPglite,
} from "./migrated-pglite.test-fixtures.ts";

const MIGRATION = "0108_clear_settled_a2a_canceled_at";

type TaskRow = {
  id: string;
  state: string | null;
  canceled_at: string | null;
};

const taskRows = (pg: PGlite) =>
  pg
    .query<TaskRow>(
      `SELECT "id", "state", "canceled_at" FROM "a2a_task" ORDER BY "id"`,
    )
    .then(({ rows }) => rows);

let pg: PGlite;
beforeAll(async () => {
  // why: migrate only up to the migration so the seed reflects a pre-ADR-0052 database
  pg = await migratedPglite(MIGRATION);
  await pg.exec(`
    INSERT INTO "user" ("id", "name", "email", "email_verified", "created_at", "updated_at")
      VALUES ('u1', 'Jane', 'jane@example.com', true, now(), now());
    INSERT INTO "organization" ("id", "name") VALUES ('org-1', 'Acme');
    INSERT INTO "workspace" ("id", "organization_id", "owner_id", "name")
      VALUES ('ws-1', 'org-1', 'u1', 'Support');
    INSERT INTO "chat" ("id", "workspace_id", "title", "status")
      VALUES ('chat-1', 'ws-1', 'A2A', 'running');
    INSERT INTO "chat_message" ("chat_id", "id", "parent_id", "role", "parts", "created_at")
      VALUES ('chat-1', 'msg-a', NULL, 'user', '[]', now()),
             ('chat-1', 'msg-b', NULL, 'user', '[]', now());
    INSERT INTO "a2a_task" ("id", "chat_id", "message_id", "state", "canceled_at", "status_at")
      VALUES ('task-live', 'chat-1', 'msg-a', NULL, NULL, now()),
             ('task-settled', 'chat-1', 'msg-b', 'canceled', now() - interval '1 hour', now());
  `);
}, 120_000);
afterAll(() => pg.close());

describe(MIGRATION, () => {
  beforeAll(async () => {
    await applyMigration(pg, MIGRATION);
  }, 120_000);

  it("clears the cancel stamp a settled Task carries from before the sweep matched turns", async () => {
    expect(await taskRows(pg)).toEqual([
      { id: "task-live", state: null, canceled_at: null },
      { id: "task-settled", state: "canceled", canceled_at: null },
    ]);
  });

  it("is idempotent when applied a second time", async () => {
    const afterFirst = await taskRows(pg);
    await expect(applyMigration(pg, MIGRATION)).resolves.toBeUndefined();
    expect(await taskRows(pg)).toEqual(afterFirst);
  });
});
