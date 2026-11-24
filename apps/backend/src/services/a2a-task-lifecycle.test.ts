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
import { eq, sql } from "drizzle-orm";
import { TaskState } from "@a2a-js/sdk";
import { migratedPglite } from "../db/migrated-pglite.test-fixtures.ts";
import { seedA2aWorkspace } from "./a2a.test-fixtures.ts";
import {
  a2aPushConfig as a2aPushConfigTable,
  a2aTask as a2aTaskTable,
} from "../db/schema.ts";
import type { Tx } from "../index.ts";

const { holder, mockCancelRun, mockPostWithRetries } = vi.hoisted(() => ({
  holder: { db: undefined as ReturnType<typeof drizzle> | undefined },
  mockCancelRun: vi.fn(),
  mockPostWithRetries: vi.fn(),
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
vi.mock("./webhook-delivery.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./webhook-delivery.ts")>();
  mockPostWithRetries.mockImplementation(actual.postWithRetries);
  return { ...actual, postWithRetries: mockPostWithRetries };
});

const { cancelTask, endTurnIn, readTask, sweepMissedEnds, turnEnded } =
  await import("./a2a-task-lifecycle.ts");
const { MAX_PUSHES_PER_TASK, PUSH_LEASE_MS } = await import("./a2a-push.ts");

const HOOK = "http://10.0.0.5/hook";

let pg: PGlite;
const fetchMock = vi.fn();
beforeAll(async () => {
  pg = await migratedPglite();
  await seedA2aWorkspace(pg);
  await pg.exec(`
    INSERT INTO "a2a_endpoint" ("id", "workspace_id", "agent_id", "name", "description")
      VALUES ('ep-1', 'ws-1', 'agent-1', 'Helper', 'Helps');
    INSERT INTO "a2a_token" ("id", "endpoint_id", "name", "token_hash", "token_created_at", "token_expires_at")
      VALUES ('tok-1', 'ep-1', 'Client', 'h', now(), now() + interval '30 days');
  `);
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
  mockPostWithRetries.mockClear();
  await pg.exec(`
    DELETE FROM "a2a_push_config";
    DELETE FROM "a2a_task";
    DELETE FROM "chat";
    INSERT INTO "chat" ("id", "workspace_id", "title", "status")
      VALUES ('chat-1', 'ws-1', 'A2A', 'running');
    INSERT INTO "chat_message" ("chat_id", "id", "parent_id", "role", "parts", "created_at")
      VALUES ('chat-1', 'msg-1', NULL, 'user', '[]', now() - interval '1 minute'),
             ('chat-1', 'reply-1', 'msg-1', 'assistant', '[{"type":"text","text":"Hi"}]', now());
    UPDATE "chat" SET "active_leaf_id" = 'reply-1' WHERE "id" = 'chat-1';
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

const taskRow = async () => {
  const [row] = await db()
    .select()
    .from(a2aTaskTable)
    .where(eq(a2aTaskTable.id, "task-1"));
  return row;
};

const endRun = (status: "succeeded" | "failed" | "cancelled") =>
  db().transaction(async (tx) => {
    await tx.execute(
      sql`UPDATE "chat" SET "status" = ${status} WHERE "id" = 'chat-1'`,
    );
    return endTurnIn(tx as unknown as Tx, "chat-1", "msg-1", status);
  });

const configRow = async () => {
  const [row] = await db().select().from(a2aPushConfigTable);
  return row;
};

const expireLease = () =>
  pg.exec(
    `UPDATE "a2a_push_config"
      SET "claimed_at" = now() - make_interval(secs => ${PUSH_LEASE_MS / 1000 + 60})`,
  );

const awaitPushes = async (claimed: number) => {
  await vi.waitFor(async () => {
    expect((await taskRow()).pushCount).toBe(claimed);
  });
};

const pushedStates = () =>
  fetchMock.mock.calls.map(
    ([, init]) =>
      (
        JSON.parse((init as RequestInit).body as string) as {
          task: { status: { state: string } };
        }
      ).task.status.state,
  );

const pushesLanded = async () => {
  await vi.waitFor(async () => {
    const [config] = await db()
      .select({ notifiedAt: a2aPushConfigTable.notifiedAt })
      .from(a2aPushConfigTable);
    expect(config.notifiedAt).not.toBeNull();
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
    expect(await taskRow()).toMatchObject({
      state: "canceled",
      canceledAt: null,
    });
    expect(mockCancelRun).toHaveBeenCalledWith("chat-1", { turnId: "msg-1" });
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
    await pg.exec(`
      UPDATE "chat_message" SET "deleted_at" = now() WHERE "id" = 'reply-1';
      UPDATE "chat" SET "status" = 'failed', "active_leaf_id" = 'msg-1';
    `);

    const again = await readTask(await taskRow());
    await pushesLanded();

    expect(again.status).toEqual(first.status);
    expect(again.status!.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(again.artifacts).toEqual([]);
    expect(pushedStates()).toEqual(["TASK_STATE_COMPLETED"]);
  });

  it("would read a different end had nothing recorded the first", async () => {
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

  it("records an end no one recorded for a Task with no push config", async () => {
    await pg.exec(`
      DELETE FROM "a2a_push_config";
      UPDATE "chat" SET "status" = 'succeeded'
    `);

    await sweepMissedEnds();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(await taskRow()).toMatchObject({
      state: "completed",
      replyId: "reply-1",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("leaves a Task whose turn is still running", async () => {
    await sweepMissedEnds();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(await taskRow()).toMatchObject({ state: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("retries a push interrupted after its claim once the lease expires", async () => {
    await pg.exec(
      `UPDATE "a2a_task" SET "state" = 'completed', "reply_id" = 'reply-1'`,
    );
    fetchMock.mockImplementationOnce(() => new Promise<Response>(() => {}));
    void sweepMissedEnds();
    await vi.waitFor(async () => {
      expect((await configRow()).claimedAt).not.toBeNull();
    });

    expect((await configRow()).notifiedAt).toBeNull();

    await expireLease();
    await sweepMissedEnds();
    await pushesLanded();

    expect((await configRow()).notifiedAt).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("doesn't retry a push the receiving URL refused", async () => {
    await pg.exec(
      `UPDATE "a2a_task" SET "state" = 'completed', "reply_id" = 'reply-1'`,
    );
    mockPostWithRetries.mockResolvedValueOnce("refused");

    await sweepMissedEnds();
    await vi.waitFor(async () => {
      expect((await configRow()).failedAt).not.toBeNull();
    });
    expect((await configRow()).notifiedAt).toBeNull();

    await expireLease();
    await sweepMissedEnds();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(mockPostWithRetries).toHaveBeenCalledOnce();
  });

  it("retries a push whose attempts got no answer", async () => {
    await pg.exec(
      `UPDATE "a2a_task" SET "state" = 'completed', "reply_id" = 'reply-1'`,
    );
    mockPostWithRetries
      .mockResolvedValueOnce("unknown")
      .mockResolvedValueOnce("delivered");

    await sweepMissedEnds();
    await vi.waitFor(() => {
      expect(mockPostWithRetries).toHaveBeenCalledOnce();
    });
    expect(await configRow()).toMatchObject({
      notifiedAt: null,
      failedAt: null,
    });

    await expireLease();
    await sweepMissedEnds();
    await pushesLanded();

    expect(mockPostWithRetries).toHaveBeenCalledTimes(2);
  });

  it("never delivers a config whose lease is live", async () => {
    await pg.exec(`
      UPDATE "a2a_task" SET "state" = 'completed', "reply_id" = 'reply-1';
      UPDATE "a2a_push_config" SET "claimed_at" = now();
    `);

    await sweepMissedEnds();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("delivers a config once when two callers race for it", async () => {
    await pg.exec(
      `UPDATE "a2a_task" SET "state" = 'completed', "reply_id" = 'reply-1'`,
    );

    await Promise.all([sweepMissedEnds(), sweepMissedEnds()]);
    await pushesLanded();

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("sends a Task no more than its push ceiling while leases expire", async () => {
    await pg.exec(
      `UPDATE "a2a_task" SET "state" = 'completed', "reply_id" = 'reply-1'`,
    );
    fetchMock.mockImplementation(() => new Promise<Response>(() => {}));

    for (let claimed = 1; claimed <= MAX_PUSHES_PER_TASK; claimed++) {
      void sweepMissedEnds();
      await awaitPushes(claimed);
      await expireLease();
    }
    void sweepMissedEnds();
    await vi.waitFor(async () => {
      expect((await configRow()).failedAt).not.toBeNull();
    });

    expect(fetchMock).toHaveBeenCalledTimes(MAX_PUSHES_PER_TASK);
  });
});
