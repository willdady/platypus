import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { migratedPglite } from "./migrated-pglite.test-fixtures.ts";

/**
 * An A2A endpoint goes with its Agent, and its tokens go with it, while its
 * Chats and Tasks stay (ADR-0032), by the foreign keys the shipped migrations
 * create.
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
    INSERT INTO "a2a_endpoint" ("id", "workspace_id", "agent_id", "name", "description")
      VALUES ('ep-1', 'ws-1', 'agent-1', 'Helper', 'Helps');
    INSERT INTO "a2a_token" ("id", "endpoint_id", "name", "token_hash", "token_created_at", "token_expires_at")
      VALUES ('tok-1', 'ep-1', 'Hermes', 'h', now(), now() + interval '90 days');
  `);
}, 60_000);
afterAll(() => pg.close());

const count = async (table: string) =>
  (await pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM "${table}"`))
    .rows[0].n;

describe("A2A endpoint foreign keys", () => {
  it("are off by default on the Organization and Workspace", async () => {
    const { rows } = await pg.query<{ a2a_gate: string; a2a_allowed: boolean }>(
      `SELECT o."a2a_gate", w."a2a_allowed" FROM "organization" o JOIN "workspace" w ON w."organization_id" = o."id"`,
    );
    expect(rows).toEqual([{ a2a_gate: "off", a2a_allowed: false }]);
  });

  // #1239 story 19: deleting an endpoint leaves the Owner its conversations.
  it("keep a deleted endpoint's Chats and Tasks", async () => {
    await pg.exec(`
      INSERT INTO "a2a_endpoint" ("id", "workspace_id", "agent_id", "name", "description")
        VALUES ('ep-2', 'ws-1', 'agent-1', 'Desk', 'Desk');
      INSERT INTO "a2a_token" ("id", "endpoint_id", "name", "token_hash", "token_created_at", "token_expires_at")
        VALUES ('tok-2', 'ep-2', 'Rovo', 'h2', now(), now() + interval '90 days');
      INSERT INTO "chat" ("id", "workspace_id", "agent_id", "title", "a2a_token_id", "a2a_client_name", "a2a_endpoint_id")
        VALUES ('chat-2', 'ws-1', 'agent-1', 'Where is my order?', 'tok-2', 'Rovo', 'ep-2');
      INSERT INTO "chat_message" ("chat_id", "id", "role", "parts")
        VALUES ('chat-2', 'msg-a', 'user', '[]');
      INSERT INTO "a2a_task" ("id", "chat_id", "message_id", "endpoint_id", "token_id", "state")
        VALUES ('task-2', 'chat-2', 'msg-a', 'ep-2', 'tok-2', 'completed');
      DELETE FROM "a2a_endpoint" WHERE "id" = 'ep-2';
    `);

    const chats = await pg.query(
      `SELECT "a2a_endpoint_id", "a2a_token_id", "a2a_client_name" FROM "chat" WHERE "id" = 'chat-2'`,
    );
    expect(chats.rows).toEqual([
      { a2a_endpoint_id: "ep-2", a2a_token_id: null, a2a_client_name: "Rovo" },
    ]);
    const tasks = await pg.query(
      `SELECT "chat_id", "state" FROM "a2a_task" WHERE "id" = 'task-2'`,
    );
    expect(tasks.rows).toEqual([{ chat_id: "chat-2", state: "completed" }]);
    expect(await count("chat_message")).toBe(1);
  });

  it("delete an Agent's endpoints and their tokens with the Agent", async () => {
    await pg.exec(`DELETE FROM "agent" WHERE "id" = 'agent-1'`);

    expect(await count("a2a_endpoint")).toBe(0);
    expect(await count("a2a_token")).toBe(0);
  });
});
