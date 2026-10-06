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
import { drizzle } from "drizzle-orm/pglite";
import { migratedPglite } from "./migrated-pglite.test-fixtures.ts";
import { a2aTask as a2aTaskTable } from "./schema.ts";
import { isUniqueViolation } from "../errors.ts";

/**
 * The constraints the A2A code leans on (ADR-0032), against an in-process
 * Postgres built from the shipped migrations rather than the fake db the
 * route tests run on.
 */
const { holder } = vi.hoisted(() => ({
  holder: { db: undefined as ReturnType<typeof drizzle> | undefined },
}));
vi.mock("../index.ts", () => ({
  get db() {
    return holder.db!;
  },
}));

const { listA2aTasks } = await import("../services/a2a-task.ts");
type A2aCaller = import("../services/a2a-task.ts").A2aCaller;

let pg: PGlite;
beforeAll(async () => {
  pg = await migratedPglite();
  holder.db = drizzle(pg);
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
  `);
}, 60_000);
afterAll(() => pg.close());

const TOKEN_COLUMNS = `"id", "endpoint_id", "name", "token_hash", "token_created_at", "token_expires_at"`;

beforeEach(async () => {
  await pg.exec(`
    DELETE FROM "chat";
    DELETE FROM "a2a_endpoint";
    INSERT INTO "a2a_endpoint" ("id", "workspace_id", "agent_id", "name", "description")
      VALUES ('ep-1', 'ws-1', 'agent-1', 'Helper', 'Helps');
    INSERT INTO "a2a_token" (${TOKEN_COLUMNS})
      VALUES ('tok-1', 'ep-1', 'Hermes', 'h1', now(), now() + interval '90 days'),
             ('tok-2', 'ep-1', 'Iris', 'h2', now(), now() + interval '90 days');
    INSERT INTO "chat" ("id", "workspace_id", "title", "a2a_endpoint_id", "a2a_token_id", "a2a_client_name")
      VALUES ('chat-1', 'ws-1', 'A2A', 'ep-1', 'tok-1', 'Hermes'),
             ('chat-2', 'ws-1', 'A2A', 'ep-1', 'tok-1', 'Hermes');
    INSERT INTO "chat_message" ("chat_id", "id", "parent_id", "role", "parts")
      VALUES ('chat-1', 'msg-a', NULL, 'user', '[]'),
             ('chat-1', 'msg-b', NULL, 'user', '[]'),
             ('chat-2', 'msg-a', NULL, 'user', '[]');
    INSERT INTO "a2a_task" ("id", "chat_id", "message_id", "endpoint_id", "token_id")
      VALUES ('task-1', 'chat-1', 'msg-a', 'ep-1', 'tok-1'),
             ('task-2', 'chat-1', 'msg-b', 'ep-1', 'tok-1');
    INSERT INTO "a2a_push_config" ("id", "task_id", "url")
      VALUES ('cfg-1', 'task-1', 'https://client.example/hook'),
             ('cfg-2', 'task-2', 'https://client.example/hook');
  `);
});

const rows = async <T>(sql: string) => (await pg.query<T>(sql)).rows;
const ids = async (table: string) =>
  (await rows<{ id: string }>(`SELECT "id" FROM "${table}" ORDER BY "id"`)).map(
    (row) => row.id,
  );

describe("a2a_task (chat_id, message_id)", () => {
  it("refuses a second Task for a turn, as a unique violation", async () => {
    const error = await holder
      .db!.insert(a2aTaskTable)
      .values({ id: "task-dup", chatId: "chat-1", messageId: "msg-a" })
      .then(
        () => undefined,
        (e: unknown) => e,
      );

    expect(isUniqueViolation(error)).toBe(true);
    expect(await ids("a2a_task")).toEqual(["task-1", "task-2"]);
  });

  it("allows the same message id in another Chat", async () => {
    await pg.exec(`
      INSERT INTO "a2a_task" ("id", "chat_id", "message_id")
        VALUES ('task-3', 'chat-2', 'msg-a');
    `);

    expect(await ids("a2a_task")).toEqual(["task-1", "task-2", "task-3"]);
  });
});

describe("a2a_task's turn and push configs", () => {
  it("refuse a Task for a message its Chat does not have", async () => {
    await expect(
      pg.exec(`
        INSERT INTO "a2a_task" ("id", "chat_id", "message_id")
          VALUES ('task-3', 'chat-2', 'msg-b');
      `),
    ).rejects.toThrow(/a2a_task_chat_id_message_id_chat_message_chat_id_id_fk/);
  });

  it("go with the turn's message", async () => {
    await pg.exec(
      `DELETE FROM "chat_message" WHERE "chat_id" = 'chat-1' AND "id" = 'msg-a'`,
    );

    expect(await ids("a2a_task")).toEqual(["task-2"]);
    expect(await ids("a2a_push_config")).toEqual(["cfg-2"]);
  });

  it("go with the Chat", async () => {
    await pg.exec(`DELETE FROM "chat" WHERE "id" = 'chat-1'`);

    expect(await ids("a2a_task")).toEqual([]);
    expect(await ids("a2a_push_config")).toEqual([]);
  });

  it("push configs go with their Task", async () => {
    await pg.exec(`DELETE FROM "a2a_task" WHERE "id" = 'task-1'`);

    expect(await ids("a2a_push_config")).toEqual(["cfg-2"]);
  });
});

describe("deleting a token or endpoint", () => {
  const chats = () =>
    rows(
      `SELECT "id", "a2a_endpoint_id", "a2a_token_id" FROM "chat" ORDER BY "id"`,
    );
  const tasks = () =>
    rows(
      `SELECT "id", "endpoint_id", "token_id" FROM "a2a_task" ORDER BY "id"`,
    );

  it("keeps a token's Chats and Tasks, naming no token", async () => {
    await pg.exec(`DELETE FROM "a2a_token" WHERE "id" = 'tok-1'`);

    expect(await chats()).toEqual([
      { id: "chat-1", a2a_endpoint_id: "ep-1", a2a_token_id: null },
      { id: "chat-2", a2a_endpoint_id: "ep-1", a2a_token_id: null },
    ]);
    expect(await tasks()).toEqual([
      { id: "task-1", endpoint_id: "ep-1", token_id: null },
      { id: "task-2", endpoint_id: "ep-1", token_id: null },
    ]);
    expect(await ids("a2a_push_config")).toEqual(["cfg-1", "cfg-2"]);
  });

  it("keeps an endpoint's Chats and Tasks, naming no endpoint or token", async () => {
    await pg.exec(`DELETE FROM "a2a_endpoint" WHERE "id" = 'ep-1'`);

    expect(await ids("a2a_token")).toEqual([]);
    expect(await ids("chat")).toEqual(["chat-1", "chat-2"]);
    expect(
      await rows(`SELECT "a2a_token_id" FROM "chat" GROUP BY "a2a_token_id"`),
    ).toEqual([{ a2a_token_id: null }]);
    expect(await tasks()).toEqual([
      { id: "task-1", endpoint_id: null, token_id: null },
      { id: "task-2", endpoint_id: null, token_id: null },
    ]);
    expect(await ids("a2a_push_config")).toEqual(["cfg-1", "cfg-2"]);
  });
});

describe("A2A column defaults", () => {
  it("make an endpoint enabled, with Memories neither included nor extracted", async () => {
    expect(
      await rows(
        `SELECT "enabled", "include_memories", "extract_memories" FROM "a2a_endpoint"`,
      ),
    ).toEqual([
      { enabled: true, include_memories: false, extract_memories: false },
    ]);
  });

  it("give a token no expiry of its own: one is always written", async () => {
    await expect(
      pg.exec(`
        INSERT INTO "a2a_token" ("id", "endpoint_id", "name", "token_hash", "token_created_at")
          VALUES ('tok-3', 'ep-1', 'Juno', 'h3', now());
      `),
    ).rejects.toThrow(/token_expires_at/);
    await expect(
      pg.exec(`
        INSERT INTO "a2a_token" ("id", "endpoint_id", "name", "token_hash", "token_expires_at")
          VALUES ('tok-3', 'ep-1', 'Juno', 'h3', now());
      `),
    ).rejects.toThrow(/token_created_at/);
  });

  it("leave a new token un-noticed, unused and unrejected", async () => {
    expect(
      await rows(`
        SELECT "token_notice", "last_used_at", "last_rejected_at", "created_at" IS NOT NULL AS "created"
          FROM "a2a_token" WHERE "id" = 'tok-1'
      `),
    ).toEqual([
      {
        token_notice: null,
        last_used_at: null,
        last_rejected_at: null,
        created: true,
      },
    ]);
  });

  it("make a Task unended, unpushed, and stamped to the millisecond", async () => {
    await pg.exec(`
      INSERT INTO "a2a_task" ("id", "chat_id", "message_id", "status_at")
        VALUES ('task-3', 'chat-2', 'msg-a', '2026-01-01 00:00:00.123456');
    `);

    expect(
      await rows(`
        SELECT "state", "canceled_at", "push_count", "reply_id",
               to_char("status_at", 'SS.US') AS "status_at"
          FROM "a2a_task" WHERE "id" = 'task-3'
      `),
    ).toEqual([
      {
        state: null,
        canceled_at: null,
        push_count: 0,
        reply_id: null,
        status_at: "00.123000",
      },
    ]);
  });
});

describe("ListTasks on Postgres", () => {
  const caller = {
    endpoint: { id: "ep-1" },
    token: { id: "tok-1", name: "Hermes" },
    origin: "http://localhost",
  } as A2aCaller;

  // Four Tasks share a status timestamp, two of them only once Postgres has
  // rounded to `timestamp(3)`; they are inserted out of id order, and another
  // token's Task shares it too.
  const TIE = "2026-01-01 00:00:01";
  beforeEach(async () => {
    await pg.exec(`
      DELETE FROM "chat";
      INSERT INTO "chat" ("id", "workspace_id", "title", "a2a_endpoint_id", "a2a_token_id", "a2a_client_name")
        VALUES ('chat-1', 'ws-1', 'A2A', 'ep-1', 'tok-1', 'Hermes');
      INSERT INTO "chat_message" ("chat_id", "id", "parent_id", "role", "parts")
        SELECT 'chat-1', 'msg-' || n, NULL, 'user', '[]' FROM generate_series(1, 7) AS n;
      INSERT INTO "a2a_task" ("id", "chat_id", "message_id", "endpoint_id", "token_id", "state", "status_at")
        VALUES ('task-z', 'chat-1', 'msg-1', 'ep-1', 'tok-1', 'completed', '2026-01-01 00:00:00'),
               ('task-c', 'chat-1', 'msg-2', 'ep-1', 'tok-1', 'completed', '${TIE}.000'),
               ('task-e', 'chat-1', 'msg-3', 'ep-1', 'tok-1', 'failed', '${TIE}.0004'),
               ('task-b', 'chat-1', 'msg-4', 'ep-1', 'tok-1', 'canceled', '${TIE}.000'),
               ('task-d', 'chat-1', 'msg-5', 'ep-1', 'tok-1', 'completed', '${TIE}.0001'),
               ('task-a', 'chat-1', 'msg-6', 'ep-1', 'tok-1', 'completed', '2026-01-01 00:00:02'),
               ('task-x', 'chat-1', 'msg-7', 'ep-1', 'tok-2', 'completed', '${TIE}.000');
    `);
  });

  const ORDER = ["task-a", "task-e", "task-d", "task-c", "task-b", "task-z"];

  /** Every page, following each page token to the end. */
  const allPages = async (pageSize: number, statusTimestampAfter?: string) => {
    const pages: string[][] = [];
    let pageToken = "";
    do {
      const page = await listA2aTasks(caller, {
        pageSize,
        pageToken,
        statusTimestampAfter,
      } as never);
      expect(page.totalSize).toBe(
        statusTimestampAfter ? ORDER.length - 1 : ORDER.length,
      );
      pages.push(page.tasks.map((task) => task.id));
      pageToken = page.nextPageToken;
    } while (pageToken && pages.length <= ORDER.length);
    return pages;
  };

  it.each([1, 2, 3, 4, 5, 6])(
    "pages through the tie whole and once each, %i at a time",
    async (pageSize) => {
      const pages = await allPages(pageSize);

      expect(pages.flat()).toEqual(ORDER);
      expect(pages.every((page) => page.length <= pageSize)).toBe(true);
    },
  );

  it("lists the tie from its own timestamp, inclusively", async () => {
    const pages = await allPages(2, `${TIE.replace(" ", "T")}.000Z`);

    expect(pages.flat()).toEqual(ORDER.slice(0, -1));
  });
});
