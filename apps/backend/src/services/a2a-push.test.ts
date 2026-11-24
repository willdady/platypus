import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { TaskNotFoundError } from "@a2a-js/sdk/errors";
import { drizzle } from "drizzle-orm/pglite";
import { migratedPglite } from "../db/migrated-pglite.test-fixtures.ts";
import { seedA2aWorkspace } from "./a2a.test-fixtures.ts";
import { a2aPushConfig as a2aPushConfigTable } from "../db/schema.ts";
import type { TaskRow } from "./a2a-task-state.ts";

const { holder } = vi.hoisted(() => ({
  holder: { db: undefined as ReturnType<typeof drizzle> | undefined },
}));
// why: PGlite runs one tx at a time; inline, two registrations interleave like two connections
vi.mock("../index.ts", () => ({
  get db() {
    const db = holder.db!;
    return Object.assign(Object.create(db) as typeof db, {
      transaction: <T>(callback: (tx: typeof db) => Promise<T>) => callback(db),
    });
  },
}));

const { storePushConfig } = await import("./a2a-push.ts");

const TASK: TaskRow = {
  id: "task-1",
  chatId: "chat-1",
  contextId: null,
  messageId: "msg-a",
  endpointId: "ep-1",
  tokenId: "tok-1",
  state: null,
  canceledAt: null,
  statusAt: new Date(),
  pushCount: 0,
  replyId: null,
  createdAt: new Date(),
};

let pg: PGlite;
beforeAll(async () => {
  pg = await migratedPglite();
  await seedA2aWorkspace(pg);
  await pg.exec(`
    INSERT INTO "a2a_endpoint" ("id", "workspace_id", "agent_id", "name", "description")
      VALUES ('ep-1', 'ws-1', 'agent-1', 'Helper', 'Helps');
    INSERT INTO "a2a_token" ("id", "endpoint_id", "name", "token_hash", "token_created_at", "token_expires_at")
      VALUES ('tok-1', 'ep-1', 'Client', 'h', now(), now() + interval '30 days');
    INSERT INTO "chat" ("id", "workspace_id", "title", "status")
      VALUES ('chat-1', 'ws-1', 'A2A', 'running');
    INSERT INTO "chat_message" ("chat_id", "id", "parent_id", "role", "parts", "created_at")
      VALUES ('chat-1', 'msg-a', NULL, 'user', '[]', now());
    UPDATE "chat" SET "active_leaf_id" = 'msg-a' WHERE "id" = 'chat-1';
    INSERT INTO "a2a_task" ("id", "chat_id", "message_id", "endpoint_id", "token_id", "status_at")
      VALUES ('task-1', 'chat-1', 'msg-a', 'ep-1', 'tok-1', now());
  `);
  holder.db = drizzle(pg);
}, 60_000);
afterAll(() => pg.close());

beforeEach(async () => {
  await pg.exec(`DELETE FROM "a2a_push_config";`);
});

describe("storePushConfig", () => {
  it("registers one config when two registrations with the same id race", async () => {
    const config = {
      id: "cfg-1",
      url: "https://client.example/hook",
      token: "secret",
      authentication: null,
    };

    const results = await Promise.allSettled([
      storePushConfig(TASK, config),
      storePushConfig(TASK, config),
    ]);

    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    const rows = await holder.db!.select().from(a2aPushConfigTable);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "cfg-1",
      taskId: "task-1",
      url: "https://client.example/hook",
      token: "secret",
    });
  });

  it("throws TaskNotFoundError when the config is deleted before its update", async () => {
    const config = {
      id: "cfg-1",
      url: "https://client.example/hook",
      token: "secret",
      authentication: null,
    };
    await storePushConfig(TASK, config);
    await pg.exec(`
      CREATE FUNCTION skip_update() RETURNS trigger LANGUAGE plpgsql
        AS $$ BEGIN RETURN NULL; END $$;
      CREATE TRIGGER skip_update BEFORE UPDATE ON "a2a_push_config"
        FOR EACH ROW EXECUTE FUNCTION skip_update();
    `);

    try {
      await expect(
        storePushConfig(TASK, { ...config, token: "rotated" }),
      ).rejects.toThrow(TaskNotFoundError);
    } finally {
      await pg.exec(`
        DROP TRIGGER skip_update ON "a2a_push_config";
        DROP FUNCTION skip_update();
      `);
    }
  });
});
