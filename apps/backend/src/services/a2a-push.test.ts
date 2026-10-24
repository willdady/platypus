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
import { a2aPushConfig as a2aPushConfigTable } from "../db/schema.ts";
import type { TaskRow } from "./a2a-task-state.ts";

/**
 * Push config registration against an in-process Postgres built from the
 * shipped migrations, so the primary key is the one production has. PGlite
 * runs one transaction at a time, so each registration's statements commit
 * as they go here: two registrations then interleave the way two
 * transactions on separate connections do, both checking before either
 * inserts.
 */
const { holder } = vi.hoisted(() => ({
  holder: { db: undefined as ReturnType<typeof drizzle> | undefined },
}));
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
  // The Task's Chat, endpoint and token are beside the point; skip the FKs.
  await pg.exec("SET session_replication_role = replica");
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
    // The UPDATE then finds no row, as it would after a concurrent delete.
    // `ENABLE ALWAYS`: the replica role set above skips ordinary triggers.
    await pg.exec(`
      CREATE FUNCTION skip_update() RETURNS trigger LANGUAGE plpgsql
        AS $$ BEGIN RETURN NULL; END $$;
      CREATE TRIGGER skip_update BEFORE UPDATE ON "a2a_push_config"
        FOR EACH ROW EXECUTE FUNCTION skip_update();
      ALTER TABLE "a2a_push_config" ENABLE ALWAYS TRIGGER skip_update;
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
