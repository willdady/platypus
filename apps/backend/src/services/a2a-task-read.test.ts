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
import { and, desc, eq, isNull } from "drizzle-orm";
import { TaskState } from "@a2a-js/sdk";
import { migratedPglite } from "../db/migrated-pglite.test-fixtures.ts";
import { a2aTask as a2aTaskTable } from "../db/schema.ts";

/**
 * The A2A read paths (#1310) against an in-process Postgres built from the
 * shipped migrations: the lateral join for a turn's first reply is real SQL
 * here, and the plans are the planner's.
 */
const { holder } = vi.hoisted(() => ({
  holder: { db: undefined as ReturnType<typeof drizzle> | undefined },
}));
vi.mock("../index.ts", () => ({
  get db() {
    return holder.db!;
  },
}));

const { readTaskRows } = await import("./a2a-task-state.ts");
const { listA2aTasks } = await import("./a2a-task.ts");
type A2aCaller = import("./a2a-task.ts").A2aCaller;

const caller = {
  endpoint: { id: "ep-1" },
  token: { id: "tok-1", name: "Client" },
  origin: "http://localhost",
} as A2aCaller;

let pg: PGlite;
beforeAll(async () => {
  pg = await migratedPglite();
  // The endpoint, token and Workspace are beside the point; skip the FKs.
  await pg.exec("SET session_replication_role = replica");
  holder.db = drizzle(pg);
}, 60_000);
afterAll(() => pg.close());

beforeEach(async () => {
  await pg.exec(`
    DELETE FROM "a2a_task";
    DELETE FROM "chat_message";
    DELETE FROM "chat";
    INSERT INTO "chat" ("id", "workspace_id", "title", "status", "active_leaf_id")
      VALUES ('chat-1', 'ws-1', 'Running', 'running', 'reply-1'),
             ('chat-2', 'ws-1', 'Done', 'succeeded', 'reply-2');
    INSERT INTO "chat_message" ("chat_id", "id", "parent_id", "role", "parts", "created_at", "deleted_at")
      VALUES ('chat-1', 'msg-1', NULL, 'user', '[]', now() - interval '3 minutes', NULL),
             ('chat-1', 'gone-1', 'msg-1', 'assistant', '[]', now() - interval '2 minutes', now()),
             ('chat-1', 'reply-1', 'msg-1', 'assistant', '[]', now() - interval '1 minute', NULL),
             ('chat-1', 'later-1', 'msg-1', 'assistant', '[]', now(), NULL),
             ('chat-2', 'msg-2', NULL, 'user', '[]', now(), NULL),
             ('chat-2', 'reply-2', 'msg-2', 'assistant', '[{"type":"text","text":"Done"}]', now(), NULL);
    INSERT INTO "a2a_task" ("id", "chat_id", "message_id", "endpoint_id", "token_id", "state", "reply_id", "status_at")
      VALUES ('task-1', 'chat-1', 'msg-1', 'ep-1', 'tok-1', NULL, NULL, now() - interval '1 minute'),
             ('task-2', 'chat-2', 'msg-2', 'ep-1', 'tok-1', 'completed', 'reply-2', now());
  `);
});

describe("readTaskRows", () => {
  it("reads a running Task with its Chat and its turn's first reply still there", async () => {
    const [task] = await readTaskRows(eq(a2aTaskTable.id, "task-1"));

    expect(task).toMatchObject({
      id: "task-1",
      chatStatus: "running",
      leafId: "reply-1",
      firstReplyId: "reply-1",
    });
  });

  it("reads no reply for a Task with its end recorded", async () => {
    const [task] = await readTaskRows(eq(a2aTaskTable.id, "task-2"));

    expect(task).toMatchObject({
      id: "task-2",
      replyId: "reply-2",
      firstReplyId: null,
    });
  });
});

describe("listA2aTasks", () => {
  it("lists running and ended Tasks, with the ended one's artifact", async () => {
    const page = await listA2aTasks(caller, {
      includeArtifacts: true,
    } as never);

    expect(
      page.tasks.map((task) => [task.id, task.status!.state, task.artifacts]),
    ).toEqual([
      [
        "task-2",
        TaskState.TASK_STATE_COMPLETED,
        [expect.objectContaining({ artifactId: "reply-2" })],
      ],
      ["task-1", TaskState.TASK_STATE_WORKING, []],
    ]);
  });
});

describe("a2a_task indexes", () => {
  /** The plan Postgres picks for a query, seq scans ruled out. */
  const planOf = async (query: { sql: string; params: unknown[] }) => {
    await pg.exec("SET enable_seqscan = off");
    try {
      const { rows } = await pg.query<{ "QUERY PLAN": string }>(
        `EXPLAIN ${query.sql}`,
        query.params,
      );
      return rows.map((row) => row["QUERY PLAN"]).join("\n");
    } finally {
      await pg.exec("RESET enable_seqscan");
    }
  };

  it("serve a token's ListTasks page in order, with no sort", async () => {
    const plan = await planOf(
      holder
        .db!.select()
        .from(a2aTaskTable)
        .where(eq(a2aTaskTable.tokenId, "tok-1"))
        .orderBy(desc(a2aTaskTable.statusAt), desc(a2aTaskTable.id))
        .limit(51)
        .toSQL(),
    );

    expect(plan).toContain("idx_a2a_task_token_id_status_at_id");
    expect(plan).not.toMatch(/\bSort\b/);
  });

  it("find a token's Tasks with no end recorded", async () => {
    const plan = await planOf(
      holder
        .db!.select()
        .from(a2aTaskTable)
        .where(
          and(eq(a2aTaskTable.tokenId, "tok-1"), isNull(a2aTaskTable.state)),
        )
        .toSQL(),
    );

    expect(plan).toContain("idx_a2a_task_token_id_unended");
  });
});
