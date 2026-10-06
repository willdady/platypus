import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { TaskState } from "@a2a-js/sdk";
import { migratedPglite } from "../db/migrated-pglite.test-fixtures.ts";
import {
  a2aPushConfig as a2aPushConfigTable,
  a2aTask as a2aTaskTable,
} from "../db/schema.ts";
import type { ChatClaimTx } from "../runs/sinks/chat-sink.ts";

/**
 * The A2A Task lifecycle (ADR-0034) against an in-process Postgres built from
 * the shipped migrations: every end is a conditional update, so they are what
 * is exercised. PGlite runs one transaction at a time, so these pin the
 * transactions' semantics in either order, not true concurrency. Pushes are
 * observed at `fetch`; whether the Task's client is still live, and the
 * cancel message to the run's instance, are beside the point and stubbed.
 */
const { holder, mockCancelRun } = vi.hoisted(() => ({
  holder: { db: undefined as ReturnType<typeof drizzle> | undefined },
  mockCancelRun: vi.fn(),
}));
vi.mock("../index.ts", () => ({
  get db() {
    return holder.db!;
  },
}));
vi.mock("./a2a-liveness.ts", () => ({
  taskIsLive: () => Promise.resolve(true),
}));
vi.mock("../runs/run-cancel.ts", () => ({ cancelRun: mockCancelRun }));

const { cancelTask, endTurnIn, readTask, sweepMissedEnds, turnEnded } =
  await import("./a2a-task-lifecycle.ts");

const HOOK = "http://10.0.0.5/hook";

let pg: PGlite;
const fetchMock = vi.fn();
beforeAll(async () => {
  pg = await migratedPglite();
  // The endpoint, token and Workspace are beside the point; skip the FKs.
  await pg.exec("SET session_replication_role = replica");
  holder.db = drizzle(pg);
}, 60_000);
afterAll(() => pg.close());

beforeEach(async () => {
  vi.stubEnv("A2A_PUSH_ALLOW_PRIVATE_NETWORKS", "true");
  fetchMock.mockReset();
  fetchMock.mockImplementation(() =>
    Promise.resolve(new Response(null, { status: 200 })),
  );
  vi.stubGlobal("fetch", fetchMock);
  mockCancelRun.mockReset();
  mockCancelRun.mockResolvedValue(undefined);
  // A Chat running the turn answering `msg-1`, which has begun its reply, and
  // that turn's Task with one push config owed.
  await pg.exec(`
    DELETE FROM "a2a_push_config";
    DELETE FROM "a2a_task";
    DELETE FROM "chat_message";
    DELETE FROM "chat";
    INSERT INTO "chat" ("id", "workspace_id", "title", "status", "active_leaf_id")
      VALUES ('chat-1', 'ws-1', 'A2A', 'running', 'reply-1');
    INSERT INTO "chat_message" ("chat_id", "id", "parent_id", "role", "parts", "created_at")
      VALUES ('chat-1', 'msg-1', NULL, 'user', '[]', now() - interval '1 minute'),
             ('chat-1', 'reply-1', 'msg-1', 'assistant', '[{"type":"text","text":"Hi"}]', now());
    INSERT INTO "a2a_task" ("id", "chat_id", "message_id", "endpoint_id", "token_id", "state", "reply_id", "status_at")
      VALUES ('task-1', 'chat-1', 'msg-1', 'ep-1', 'tok-1', NULL, NULL, now());
    INSERT INTO "a2a_push_config" ("id", "task_id", "url")
      VALUES ('cfg-1', 'task-1', '${HOOK}');
  `);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const db = () => holder.db!;

/** The Task's row as it is now. */
const taskRow = async () => {
  const [row] = await db()
    .select()
    .from(a2aTaskTable)
    .where(eq(a2aTaskTable.id, "task-1"));
  return row;
};

/** Ends the Chat's run with `status`, as the sink's terminal write does. */
const endRun = (status: "succeeded" | "failed" | "cancelled") =>
  db().transaction(async (tx) => {
    await tx.execute(
      `UPDATE "chat" SET "status" = '${status}' WHERE "id" = 'chat-1'` as never,
    );
    return endTurnIn(tx as unknown as ChatClaimTx, "chat-1", "msg-1", status);
  });

/** The states each push delivered, in order. */
const pushedStates = () =>
  fetchMock.mock.calls.map(
    ([, init]) =>
      (
        JSON.parse((init as RequestInit).body as string) as {
          task: { status: { state: string } };
        }
      ).task.status.state,
  );

/** Waits for the pushes started in the background to land, then a bit more. */
const pushesLanded = async () => {
  await vi.waitFor(async () => {
    const [config] = await db()
      .select({ notifiedAt: a2aPushConfigTable.notifiedAt })
      .from(a2aPushConfigTable);
    expect(config?.notifiedAt).not.toBeNull();
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
};

describe("a Task's end", () => {
  it("recorded in the run's terminal transaction stands over a later end", async () => {
    await endRun("succeeded");
    await turnEnded({ chatId: "chat-1", turnId: "msg-1", status: "failed" });
    await pushesLanded();

    expect(await taskRow()).toMatchObject({
      state: "completed",
      replyId: "reply-1",
    });
    expect(pushedStates()).toEqual(["TASK_STATE_COMPLETED"]);
  });
});

describe("cancelTask", () => {
  it("claims a running Task first, and the run's end then records nothing", async () => {
    const claimed = await cancelTask(await taskRow());
    const ended = await endRun("succeeded");
    await pushesLanded();

    expect(claimed).toMatchObject({ id: "task-1", state: "canceled" });
    expect(ended).toBeUndefined();
    expect(await taskRow()).toMatchObject({ state: "canceled" });
    expect(mockCancelRun).toHaveBeenCalledOnce();
    expect(pushedStates()).toEqual(["TASK_STATE_CANCELED"]);
  });

  it("after the run's end claims nothing and stops nothing", async () => {
    const task = await taskRow();
    await endRun("succeeded");

    expect(await cancelTask(task)).toBeUndefined();
    expect(await taskRow()).toMatchObject({ state: "completed" });
    expect(mockCancelRun).not.toHaveBeenCalled();
  });

  it("after the run's end, though no end is recorded, claims nothing", async () => {
    const task = await taskRow();
    await pg.exec(`UPDATE "chat" SET "status" = 'succeeded'`);

    expect(await cancelTask(task)).toBeUndefined();
    await pushesLanded();
    expect(await taskRow()).toMatchObject({ state: "completed" });
    expect(mockCancelRun).not.toHaveBeenCalled();
    expect(pushedStates()).toEqual(["TASK_STATE_COMPLETED"]);
  });
});

describe("turnEnded", () => {
  it("records a dead run's turn failed, and pushes it", async () => {
    await pg.exec(`UPDATE "chat" SET "status" = 'failed'`);
    await turnEnded({ chatId: "chat-1", turnId: "msg-1", status: "failed" });
    await pushesLanded();

    expect(await taskRow()).toMatchObject({ state: "failed" });
    expect(pushedStates()).toEqual(["TASK_STATE_FAILED"]);
  });

  it("records an orphaned Chat's current turn failed, and pushes it", async () => {
    await pg.exec(`UPDATE "chat" SET "status" = 'failed'`);
    await turnEnded({ chatId: "chat-1", status: "failed" });
    await pushesLanded();

    expect(await taskRow()).toMatchObject({ state: "failed" });
    expect(pushedStates()).toEqual(["TASK_STATE_FAILED"]);
  });

  it("pushes an end recorded in the terminal transaction once, however often it is told", async () => {
    await endRun("failed");
    await Promise.all([
      turnEnded({ chatId: "chat-1", turnId: "msg-1", status: "failed" }),
      turnEnded({ chatId: "chat-1", turnId: "msg-1", status: "failed" }),
    ]);
    await sweepMissedEnds();
    await pushesLanded();

    expect(pushedStates()).toEqual(["TASK_STATE_FAILED"]);
  });
});

describe("readTask", () => {
  it("records an end it reads before anyone recorded it, and pushes it", async () => {
    await pg.exec(`UPDATE "chat" SET "status" = 'succeeded'`);

    const read = await readTask(await taskRow());
    await pushesLanded();

    expect(read.status!.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(read.artifacts).toEqual([
      expect.objectContaining({ artifactId: "reply-1" }),
    ]);
    expect(await taskRow()).toMatchObject({
      state: "completed",
      replyId: "reply-1",
    });
    expect(pushedStates()).toEqual(["TASK_STATE_COMPLETED"]);
  });

  it("keeps the end it recorded after the reply is regenerated", async () => {
    await pg.exec(`UPDATE "chat" SET "status" = 'succeeded'`);
    const first = await readTask(await taskRow());
    // The Owner regenerates the reply, and the regenerate fails.
    await pg.exec(`
      UPDATE "chat_message" SET "deleted_at" = now() WHERE "id" = 'reply-1';
      UPDATE "chat" SET "status" = 'failed', "active_leaf_id" = 'msg-1';
    `);

    const again = await readTask(await taskRow());
    await pushesLanded();

    expect(again.status).toEqual(first.status);
    expect(again.status!.state).toBe(TaskState.TASK_STATE_COMPLETED);
    // Its reply was deleted, so it reads with no artifact.
    expect(again.artifacts).toEqual([]);
    expect(pushedStates()).toEqual(["TASK_STATE_COMPLETED"]);
  });

  it("would read a different end had nothing recorded the first", async () => {
    // The same Chat as above, never read until after the regenerate failed.
    await pg.exec(`
      UPDATE "chat_message" SET "deleted_at" = now() WHERE "id" = 'reply-1';
      UPDATE "chat" SET "status" = 'failed', "active_leaf_id" = 'msg-1';
    `);

    const read = await readTask(await taskRow());
    await pushesLanded();

    expect(read.status!.state).toBe(TaskState.TASK_STATE_FAILED);
    expect(pushedStates()).toEqual(["TASK_STATE_FAILED"]);
  });
});

describe("sweepMissedEnds", () => {
  it("pushes an end recorded with no push sent", async () => {
    await pg.exec(
      `UPDATE "a2a_task" SET "state" = 'completed', "reply_id" = 'reply-1'`,
    );

    await sweepMissedEnds();
    await pushesLanded();

    expect(pushedStates()).toEqual(["TASK_STATE_COMPLETED"]);
  });

  it("records and pushes an end no one recorded once its Chat stops", async () => {
    await pg.exec(`UPDATE "chat" SET "status" = 'cancelled'`);

    await sweepMissedEnds();
    await pushesLanded();

    expect(await taskRow()).toMatchObject({ state: "canceled" });
    expect(pushedStates()).toEqual(["TASK_STATE_CANCELED"]);
  });

  it("leaves a Task whose turn is still running", async () => {
    await sweepMissedEnds();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(await taskRow()).toMatchObject({ state: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
