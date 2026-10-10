import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { migratedPglite } from "./migrated-pglite.test-fixtures.ts";

/**
 * A Notification outlives the Chat or Trigger run it was posted from, its
 * source reading as none once that is gone (#1229), by the foreign keys the
 * shipped migrations create.
 */
let pg: PGlite;
beforeAll(async () => {
  pg = await migratedPglite();
  await pg.exec(`
    INSERT INTO "user" ("id", "name", "email", "email_verified", "created_at", "updated_at")
      VALUES ('u1', 'Jane', 'jane@example.com', true, now(), now());
    INSERT INTO "organization" ("id", "name") VALUES ('org-1', 'Acme');
    INSERT INTO "workspace" ("id", "organization_id", "owner_id", "name")
      VALUES ('ws-1', 'org-1', 'u1', 'Support');
    INSERT INTO "provider" ("id", "workspace_id", "name", "provider_type", "api_key", "task_model_id", "memory_extraction_model_id", "modelIds")
      VALUES ('p1', 'ws-1', 'P', 'openai', 'k', 'm', 'm', '[]');
    INSERT INTO "agent" ("id", "workspace_id", "provider_id", "name", "description", "model_id")
      VALUES ('agent-1', 'ws-1', 'p1', 'Helper', 'Helps', 'm');
    INSERT INTO "chat" ("id", "workspace_id", "agent_id", "title")
      VALUES ('chat-1', 'ws-1', 'agent-1', 'Hi');
    INSERT INTO "trigger" ("id", "workspace_id", "agent_id", "type", "name", "instruction", "config")
      VALUES ('t1', 'ws-1', 'agent-1', 'cron', 'Nightly', 'Go', '{}');
    INSERT INTO "trigger_run" ("id", "trigger_id") VALUES ('run-1', 't1');
    INSERT INTO "notification" ("id", "workspace_id", "agent_id", "body", "source_chat_id")
      VALUES ('n-chat', 'ws-1', 'agent-1', 'From a Chat', 'chat-1');
    INSERT INTO "notification" ("id", "workspace_id", "agent_id", "body", "source_trigger_run_id")
      VALUES ('n-run', 'ws-1', 'agent-1', 'From a run', 'run-1');
  `);
}, 60_000);
afterAll(() => pg.close());

const sourceOf = async (id: string) =>
  (
    await pg.query(
      `SELECT "source_chat_id", "source_trigger_run_id" FROM "notification" WHERE "id" = $1`,
      [id],
    )
  ).rows;

describe("a Notification's source", () => {
  it("clears when its Chat is deleted, keeping the Notification", async () => {
    await pg.exec(`DELETE FROM "chat" WHERE "id" = 'chat-1'`);

    expect(await sourceOf("n-chat")).toEqual([
      { source_chat_id: null, source_trigger_run_id: null },
    ]);
  });

  it("clears when its Trigger run is pruned, keeping the Notification", async () => {
    await pg.exec(`DELETE FROM "trigger_run" WHERE "id" = 'run-1'`);

    expect(await sourceOf("n-run")).toEqual([
      { source_chat_id: null, source_trigger_run_id: null },
    ]);
  });
});
