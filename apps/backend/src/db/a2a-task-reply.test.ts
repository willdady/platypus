import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { migratedPglite } from "./migrated-pglite.test-fixtures.ts";

/**
 * An A2A Task's recorded reply (#1298), by the foreign key the shipped
 * migrations create: a reply removed for good leaves the Task, with no reply,
 * and the Task still goes with its Chat.
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
  `);
}, 60_000);
afterAll(() => pg.close());

beforeEach(async () => {
  await pg.exec(`
    DELETE FROM "chat";
    INSERT INTO "chat" ("id", "workspace_id", "title") VALUES ('chat-1', 'ws-1', 'A2A');
    INSERT INTO "chat_message" ("chat_id", "id", "parent_id", "role", "parts")
      VALUES ('chat-1', 'msg-a', NULL, 'user', '[]'),
             ('chat-1', 'reply-a', 'msg-a', 'assistant', '[]');
    INSERT INTO "a2a_task" ("id", "chat_id", "message_id", "state", "reply_id")
      VALUES ('task-1', 'chat-1', 'msg-a', 'completed', 'reply-a');
  `);
});

const tasks = async () =>
  (
    await pg.query<{ chat_id: string; state: string; reply_id: string | null }>(
      `SELECT "chat_id", "state", "reply_id" FROM "a2a_task"`,
    )
  ).rows;

describe("a2a_task.reply_id", () => {
  it("is cleared when its reply is removed, leaving the Task and its state", async () => {
    await pg.exec(
      `DELETE FROM "chat_message" WHERE "chat_id" = 'chat-1' AND "id" = 'reply-a'`,
    );

    expect(await tasks()).toEqual([
      { chat_id: "chat-1", state: "completed", reply_id: null },
    ]);
  });

  it("never names a message of another Chat", async () => {
    await expect(
      pg.exec(`UPDATE "a2a_task" SET "reply_id" = 'reply-elsewhere'`),
    ).rejects.toThrow(/a2a_task_reply_fk/);
  });

  it("lets the Chat be deleted, Task and all", async () => {
    await pg.exec(`DELETE FROM "chat" WHERE "id" = 'chat-1'`);

    expect(await tasks()).toEqual([]);
  });
});
