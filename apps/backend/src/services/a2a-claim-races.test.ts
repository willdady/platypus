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
import { SendMessageRequest } from "@a2a-js/sdk";
import { migratedPglite } from "../db/migrated-pglite.test-fixtures.ts";
import { a2aTask as a2aTaskTable } from "../db/schema.ts";
import { ConflictError } from "../errors.ts";
import { ChatSink, CHAT_BUSY_MESSAGE } from "../runs/sinks/chat-sink.ts";

const { holder, mockPrepareTurn, mockCancelRun } = vi.hoisted(() => ({
  holder: {
    db: undefined as ReturnType<typeof drizzle> | undefined,
    beforeClaim: undefined as (() => Promise<void>) | undefined,
  },
  mockPrepareTurn: vi.fn(),
  mockCancelRun: vi.fn(),
}));
vi.mock("../index.ts", () => ({
  get db() {
    return holder.db!;
  },
}));
vi.mock("./chat-execution.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./chat-execution.ts")>()),
  prepareChatTurn: mockPrepareTurn,
}));
vi.mock("../runs/run-cancel.ts", () => ({ cancelRun: mockCancelRun }));
vi.mock("./chat-summary.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./chat-summary.ts")>();
  return {
    ...actual,
    loadChatSummaries: async (chatId: string) => {
      await holder.beforeClaim?.();
      return actual.loadChatSummaries(chatId);
    },
  };
});

const { cancelTask } = await import("./a2a-task-lifecycle.ts");
const { sendA2aMessage, A2aChatBusyError } = await import("./a2a-task.ts");
type A2aCaller = import("./a2a-task.ts").A2aCaller;
type BusyError = InstanceType<typeof A2aChatBusyError>;

const caller: A2aCaller = {
  endpoint: {
    id: "ep-1",
    workspaceId: "ws-1",
    agentId: "agent-1",
    organizationId: "org-1",
    ownerId: "u1",
    includeMemories: false,
  } as A2aCaller["endpoint"],
  token: { id: "tok-1", name: "Hermes", tokenCreatedAt: new Date() },
  origin: "http://localhost",
};

let pg: PGlite;
beforeAll(async () => {
  pg = await migratedPglite();
  await pg.exec("SET session_replication_role = replica");
  holder.db = drizzle(pg);
}, 60_000);
afterAll(() => pg.close());

beforeEach(async () => {
  mockCancelRun.mockReset();
  mockCancelRun.mockResolvedValue(undefined);
  mockPrepareTurn.mockReset();
  holder.beforeClaim = undefined;
  await pg.exec(`
    DELETE FROM "a2a_task";
    DELETE FROM "chat_message";
    DELETE FROM "chat";
    DELETE FROM "workspace";
    DELETE FROM "organization";
    DELETE FROM "user";
    INSERT INTO "user" ("id", "name", "email", "email_verified", "created_at", "updated_at")
      VALUES ('u1', 'Jane', 'jane@example.com', true, now(), now());
    INSERT INTO "organization" ("id", "name") VALUES ('org-1', 'Acme');
    INSERT INTO "workspace" ("id", "organization_id", "owner_id", "name")
      VALUES ('ws-1', 'org-1', 'u1', 'Support');
  `);
});

const seedRunningTurn = () =>
  pg.exec(`
    INSERT INTO "chat" ("id", "workspace_id", "agent_id", "title", "status", "active_leaf_id", "a2a_token_id", "a2a_endpoint_id", "last_turn_at", "run_heartbeat_at")
      VALUES ('chat-1', 'ws-1', 'agent-1', 'Where is my order?', 'running', 'msg-a', 'tok-1', 'ep-1', now(), now());
    INSERT INTO "chat_message" ("chat_id", "id", "parent_id", "role", "parts", "created_at")
      VALUES ('chat-1', 'msg-a', NULL, 'user', '[{"type":"text","text":"Where is my order?"}]', now());
    INSERT INTO "a2a_task" ("id", "chat_id", "message_id", "endpoint_id", "token_id", "state", "status_at")
      VALUES ('task-a', 'chat-1', 'msg-a', 'ep-1', 'tok-1', NULL, now());
  `);

const seedIdleChat = () =>
  pg.exec(`
    INSERT INTO "chat" ("id", "workspace_id", "agent_id", "title", "status", "active_leaf_id", "a2a_token_id", "a2a_endpoint_id", "last_turn_at", "run_heartbeat_at")
      VALUES ('chat-1', 'ws-1', 'agent-1', 'Where is my order?', 'succeeded', NULL, 'tok-1', 'ep-1', now(), now());
  `);

const taskRows = async () => holder.db!.select().from(a2aTaskTable);

const taskRow = async () => (await taskRows())[0];

const chat = async () =>
  (
    await pg.query<{ status: string; active_leaf_id: string | null }>(
      `SELECT "status", "active_leaf_id" FROM "chat" WHERE "id" = 'chat-1'`,
    )
  ).rows[0];

const send = (messageId: string) =>
  sendA2aMessage(
    caller,
    SendMessageRequest.fromJSON({
      message: {
        messageId,
        role: "ROLE_USER",
        contextId: "chat-1",
        parts: [{ text: "Where is my order?" }],
      },
      configuration: { returnImmediately: true },
    }),
  );

const started = (work: Promise<unknown>) =>
  work.then(
    (task) => ({ won: true as const, task }),
    (error: unknown) => ({ won: false as const, error }),
  );

const refusedTaskId = (outcome: Awaited<ReturnType<typeof started>>) => {
  if (outcome.won) throw new Error("expected the SendMessage to be refused");
  expect(outcome.error).toBeInstanceOf(A2aChatBusyError);
  return (outcome.error as BusyError).taskId;
};

const claim = (messageId: string) =>
  new ChatSink({
    orgId: "org-1",
    workspaceId: "ws-1",
    ownerId: "u1",
    message: {
      id: messageId,
      role: "user",
      parts: [{ type: "text", text: "Where is my order?" }],
    },
    parentId: null,
    onClaimed: async (tx) => {
      await tx.insert(a2aTaskTable).values({
        id: `task-${messageId}`,
        chatId: "chat-1",
        messageId,
        endpointId: "ep-1",
        tokenId: "tok-1",
        statusAt: new Date(),
      });
    },
  }).onStart({ runId: "chat-1", messages: [] });

describe("two CancelTasks racing on one Task", () => {
  it("cancels once, refusing the other as not cancelable, with no test-side serialization", async () => {
    await seedRunningTurn();
    const [fromFirstCall, fromSecondCall] = await Promise.all([
      taskRow(),
      taskRow(),
    ]);

    const results = await Promise.all([
      cancelTask(fromFirstCall),
      cancelTask(fromSecondCall),
    ]);

    const claimed = results.filter((row) => row !== undefined);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({ id: "task-a", state: "canceled" });
    expect(mockCancelRun).toHaveBeenCalledExactlyOnceWith("chat-1", {
      turnId: "msg-a",
    });
    expect(await taskRow()).toMatchObject({ state: "canceled" });
  });
});

describe("two turns claiming one idle Chat", () => {
  it("starts exactly one, refusing the other as busy, with no test-side serialization", async () => {
    await seedIdleChat();

    const outcomes = await Promise.allSettled([
      claim("msg-b").then(() => "msg-b"),
      claim("msg-c").then(() => "msg-c"),
    ]);

    const claimed = outcomes.filter(
      (outcome): outcome is PromiseFulfilledResult<string> =>
        outcome.status === "fulfilled",
    );
    const refused = outcomes.filter(
      (outcome): outcome is PromiseRejectedResult =>
        outcome.status === "rejected",
    );
    expect(claimed).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0].reason).toBeInstanceOf(ConflictError);
    expect((refused[0].reason as ConflictError).message).toBe(
      CHAT_BUSY_MESSAGE,
    );

    const winner = claimed[0].value;
    expect(await taskRows()).toEqual([
      expect.objectContaining({ chatId: "chat-1", messageId: winner }),
    ]);
    expect(await chat()).toMatchObject({
      status: "running",
      active_leaf_id: winner,
    });
  });
});

describe("two Sends racing into one idle Chat", () => {
  it("starts one turn, and the loser's busy error names the winner's Task", async () => {
    await seedIdleChat();
    const atClaim = Promise.withResolvers<void>();
    const admission = Promise.withResolvers<void>();
    // why: the hold orders which Send reaches the Chat first; the claim itself is the database's
    let holdsLeft = 1;
    holder.beforeClaim = async () => {
      if (holdsLeft-- <= 0) return;
      atClaim.resolve();
      await admission.promise;
    };
    let release!: (error: Error) => void;
    mockPrepareTurn.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          release = reject;
        }),
    );

    const heldBeforeClaim = started(send("msg-b"));
    await atClaim.promise;
    const getsIn = started(send("msg-c"));
    await vi.waitFor(async () => expect(await taskRows()).toHaveLength(1));
    const [task] = await taskRows();

    admission.resolve();
    const refused = await heldBeforeClaim;

    expect(task).toMatchObject({ chatId: "chat-1", messageId: "msg-c" });
    expect(refusedTaskId(refused)).toBe(task.id);
    expect(await taskRows()).toHaveLength(1);

    release(new Error("the run is over"));
    expect(await getsIn).toMatchObject({ won: false });
    await vi.waitFor(async () => expect((await chat()).status).toBe("failed"));
  });
});
