import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { migratedPglite } from "./migrated-pglite.test-fixtures.ts";

/**
 * A Trigger run's Chat goes with its run (ADR-0044), by the foreign key the
 * shipped migrations create: pruning a run, deleting its Trigger or deleting
 * its Workspace leaves no orphan Chat.
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
    INSERT INTO "trigger" ("id", "workspace_id", "agent_id", "type", "name", "instruction", "config")
      VALUES ('t1', 'ws-1', 'agent-1', 'cron', 'Digest', 'Summarise', '{}');
  `);
}, 60_000);
afterAll(() => pg.close());

const count = async (table: string) =>
  (await pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM "${table}"`))
    .rows[0].n;

const runWithChat = (id: string) =>
  pg.exec(`
    INSERT INTO "trigger_run" ("id", "trigger_id", "status") VALUES ('${id}', 't1', 'success');
    INSERT INTO "chat" ("id", "workspace_id", "agent_id", "title", "trigger_run_id")
      VALUES ('${id}', 'ws-1', 'agent-1', 'Digest', '${id}');
    INSERT INTO "chat_message" ("chat_id", "id", "role", "parts")
      VALUES ('${id}', 'msg-${id}', 'user', '[]');
    UPDATE "chat" SET "active_leaf_id" = 'msg-${id}' WHERE "id" = '${id}';
  `);

describe("Trigger-run Chat foreign key", () => {
  it("defaults a Trigger's Extract Memories to off", async () => {
    const { rows } = await pg.query<{ extract_memories: boolean }>(
      `SELECT "extract_memories" FROM "trigger" WHERE "id" = 't1'`,
    );
    expect(rows).toEqual([{ extract_memories: false }]);
  });

  it("deletes the Chat and its messages with a pruned run", async () => {
    await runWithChat("r1");
    await pg.exec(`DELETE FROM "trigger_run" WHERE "id" = 'r1'`);

    expect(await count("chat")).toBe(0);
    expect(await count("chat_message")).toBe(0);
  });

  it("refuses a Chat bound to both an A2A endpoint and a Trigger run", async () => {
    await pg.exec(
      `INSERT INTO "trigger_run" ("id", "trigger_id", "status") VALUES ('r2', 't1', 'success')`,
    );
    await expect(
      pg.exec(`
        INSERT INTO "chat" ("id", "workspace_id", "title", "trigger_run_id", "a2a_endpoint_id")
          VALUES ('c2', 'ws-1', 'x', 'r2', 'ep-1');
      `),
    ).rejects.toThrow(/chat_one_binding/);
  });

  it("deletes every run's Chat with the Trigger, then with the Workspace", async () => {
    await runWithChat("r3");
    await pg.exec(`DELETE FROM "trigger" WHERE "id" = 't1'`);
    expect(await count("chat")).toBe(0);

    await pg.exec(`
      INSERT INTO "trigger" ("id", "workspace_id", "agent_id", "type", "name", "instruction", "config")
        VALUES ('t1', 'ws-1', 'agent-1', 'cron', 'Digest', 'Summarise', '{}');
    `);
    await runWithChat("r4");
    await pg.exec(`DELETE FROM "workspace" WHERE "id" = 'ws-1'`);
    expect(await count("chat")).toBe(0);
    expect(await count("trigger_run")).toBe(0);
  });
});
