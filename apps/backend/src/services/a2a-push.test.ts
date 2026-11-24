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
import { RequestMalformedError, TaskNotFoundError } from "@a2a-js/sdk/errors";
import { drizzle } from "drizzle-orm/pglite";
import { migratedPglite } from "../db/migrated-pglite.test-fixtures.ts";
import { seedA2aWorkspace } from "./a2a.test-fixtures.ts";
import { a2aPushConfig as a2aPushConfigTable } from "../db/schema.ts";
import type { TaskRow } from "./a2a-task-state.ts";

type LockEvent = { key: string; waited: boolean; overlapped: boolean };
type Release = () => void;
type Database = ReturnType<typeof drizzle>;

const { holder } = vi.hoisted(() => {
  const locks: LockEvent[] = [];
  const holders = new Map<string, number>();
  const tails = new Map<string, Promise<void>>();
  let heldAnywhere = 0;

  const acquire = async (key: string): Promise<Release> => {
    const held = holders.get(key) ?? 0;
    locks.push({ key, waited: held > 0, overlapped: heldAnywhere > 0 });
    holders.set(key, held + 1);
    heldAnywhere++;
    const prior = tails.get(key) ?? Promise.resolve();
    let release: () => void = () => {};
    const mine = new Promise<void>((resolve) => (release = resolve));
    tails.set(
      key,
      prior.then(() => mine),
    );
    await prior;
    return () => {
      holders.set(key, (holders.get(key) ?? 1) - 1);
      heldAnywhere--;
      release();
    };
  };

  const lockKey = (sql: string, params: unknown[]) => {
    if (!sql.includes('"a2a_task"') || !sql.trim().endsWith("for update")) {
      throw new Error(`row lock not modelled for: ${sql}`);
    }
    return String(params[0]);
  };

  const isBuilder = (value: unknown): value is object =>
    typeof value === "object" &&
    value !== null &&
    typeof (value as { toSQL?: unknown }).toSQL === "function";

  const lockable = (base: Database, releases: Release[]) => {
    const wrap = (builder: object): object =>
      new Proxy(builder, {
        get(target, prop) {
          if (prop === "for") {
            return (strength: string) => {
              const locked = (target as { for: (s: string) => object }).for(
                strength,
              );
              const { sql, params } = (
                locked as {
                  toSQL: () => { sql: string; params: unknown[] };
                }
              ).toSQL();
              return acquire(lockKey(sql, params)).then((release) => {
                releases.push(release);
                return locked;
              });
            };
          }
          const value: unknown = Reflect.get(target, prop, target);
          if (typeof value !== "function") return value;
          const fn = value as (...args: unknown[]) => unknown;
          if (prop === "then") return fn.bind(target);
          return (...args: unknown[]) => {
            const next: unknown = fn.apply(target, args);
            return isBuilder(next) ? wrap(next) : next;
          };
        },
      });

    return Object.assign(Object.create(base) as Database, {
      select: (...args: unknown[]) =>
        wrap((base.select as (...a: unknown[]) => object)(...args)),
    });
  };

  return {
    holder: {
      db: undefined as Database | undefined,
      locks,
      lockable,
    },
  };
});

// why: PGlite runs one tx at a time; inline, two registrations interleave like two connections, and a "for update" holds a per-Task lock until its tx ends
vi.mock("../index.ts", () => ({
  get db() {
    const base = holder.db!;
    return Object.assign(Object.create(base) as Database, {
      transaction: async <T>(
        callback: (tx: Database) => Promise<T>,
      ): Promise<T> => {
        const releases: Release[] = [];
        try {
          return await callback(holder.lockable(base, releases));
        } finally {
          for (const release of releases.reverse()) release();
        }
      },
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
      VALUES ('chat-1', 'msg-a', NULL, 'user', '[]', now()),
             ('chat-1', 'msg-b', NULL, 'user', '[]', now());
    UPDATE "chat" SET "active_leaf_id" = 'msg-a' WHERE "id" = 'chat-1';
    INSERT INTO "a2a_task" ("id", "chat_id", "message_id", "endpoint_id", "token_id", "status_at")
      VALUES ('task-1', 'chat-1', 'msg-a', 'ep-1', 'tok-1', now());
  `);
  holder.db = drizzle(pg);
}, 60_000);
afterAll(() => pg.close());

beforeEach(async () => {
  holder.locks.length = 0;
  await pg.exec(`
    DELETE FROM "a2a_push_config";
    DELETE FROM "a2a_task";
    INSERT INTO "a2a_task" ("id", "chat_id", "message_id", "push_count") VALUES
      ('task-1', 'chat-1', 'msg-a', 0),
      ('task-2', 'chat-1', 'msg-b', 0);
  `);
});

const pushConfigFor = (n: number, task = "task-1") => ({
  id: `${task}-cfg-${n}`,
  url: `https://client.example/${task}/${n}`,
  token: "secret",
  authentication: null,
});

const storedConfigs = async () => holder.db!.select().from(a2aPushConfigTable);

const fillTo = async (task: string, n: number) => {
  for (let i = 1; i <= n; i++) {
    await storePushConfig({ ...TASK, id: task }, pushConfigFor(i, task));
  }
};

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

  it("caps a Task's configs when three registrations race for the last slot", async () => {
    await fillTo("task-1", 4);

    const results = await Promise.allSettled([
      storePushConfig(TASK, pushConfigFor(5)),
      storePushConfig(TASK, pushConfigFor(6)),
      storePushConfig(TASK, pushConfigFor(7)),
    ]);

    const statuses = results
      .map((r) => r.status)
      .sort()
      .join(",");
    expect(statuses).toBe("fulfilled,rejected,rejected");
    const refusals = results
      .filter((r): r is PromiseRejectedResult => r.status === "rejected")
      .map((r): unknown => r.reason);
    for (const refusal of refusals) {
      expect(refusal).toBeInstanceOf(RequestMalformedError);
    }
    expect(
      refusals.map((refusal) => (refusal as RequestMalformedError).message),
    ).toEqual([
      "A Task takes at most 5 push notification configs",
      "A Task takes at most 5 push notification configs",
    ]);
    expect(await storedConfigs()).toHaveLength(5);
    expect(holder.locks.filter((l) => l.waited)).toHaveLength(2);
  });

  it("does not hold a registration for another Task behind the lock", async () => {
    await fillTo("task-1", 4);
    await fillTo("task-2", 4);

    const results = await Promise.allSettled([
      storePushConfig(TASK, pushConfigFor(5)),
      storePushConfig({ ...TASK, id: "task-2" }, pushConfigFor(5, "task-2")),
    ]);

    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(holder.locks.filter((l) => l.waited)).toEqual([]);
    expect(holder.locks.filter((l) => l.overlapped)).toHaveLength(1);
    expect(await storedConfigs()).toHaveLength(10);
  });
});
