import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { MockLanguageModelV3, convertArrayToReadableStream } from "ai/test";
import { resetMockDb, seedDb, type Row } from "../test-utils.ts";

// The model is the only thing mocked: everything from the JSON-RPC call to
// the Chat rows runs for real against the in-memory database.
const { model } = vi.hoisted(() => ({
  model: {
    reply: "Hello from Helper",
    /** The reply's deltas, when a test streams it in pieces. */
    deltas: null as string[] | null,
    hold: null as Promise<void> | null,
    /** Holds the stream after the reply's first words, until it settles. */
    holdMidReply: null as Promise<void> | null,
    prompts: [] as unknown[],
  },
}));
vi.mock("../services/provider.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/provider.ts")>()),
  openProvider: () => ({
    languageModel: () =>
      new MockLanguageModelV3({
        doStream: async (options) => {
          model.prompts.push(options.prompt);
          await model.hold;
          const chunks: LanguageModelV3StreamPart[] = [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "t1" },
            ...(model.deltas ?? [model.reply]).map(
              (delta): LanguageModelV3StreamPart => ({
                type: "text-delta",
                id: "t1",
                delta,
              }),
            ),
            { type: "text-end", id: "t1" },
            {
              type: "finish",
              finishReason: { unified: "stop", raw: "stop" },
              usage: {
                inputTokens: {
                  total: 1,
                  noCache: 1,
                  cacheRead: undefined,
                  cacheWrite: undefined,
                },
                outputTokens: { total: 1, text: 1, reasoning: undefined },
              },
            },
          ];
          const midReply = model.holdMidReply;
          if (!midReply) {
            return { stream: convertArrayToReadableStream(chunks) };
          }
          const signal = options.abortSignal;
          const aborted = new Promise<void>((resolve) =>
            signal?.addEventListener("abort", () => resolve(), { once: true }),
          );
          return {
            stream: new ReadableStream<LanguageModelV3StreamPart>({
              async start(controller) {
                chunks
                  .slice(0, 3)
                  .forEach((chunk) => controller.enqueue(chunk));
                await Promise.race([midReply, aborted]);
                if (signal?.aborted) return controller.error(signal.reason);
                chunks.slice(3).forEach((chunk) => controller.enqueue(chunk));
                controller.close();
              },
            }),
          };
        },
        doGenerate: () => Promise.reject(new Error("no titling in tests")),
      }),
    embeddingModel: () => {
      throw new Error("no embeddings in tests");
    },
  }),
}));

// Real, but watchable: a test can see which run a cancel asked to stop.
vi.mock("../runs/run-cancel.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../runs/run-cancel.ts")>();
  return { ...actual, cancelRun: vi.fn(actual.cancelRun) };
});

vi.mock("../services/notification.ts", () => ({
  createNotification: vi.fn(() => Promise.resolve({ id: "notification-1" })),
}));

import app from "../server.ts";
import { createNotification } from "../services/notification.ts";
import { hashInboundToken } from "../services/inbound-trigger-token.ts";
import { resetA2aTokenTouches } from "../services/a2a-token.ts";
import { activeA2aRunCount, resetA2aRunSlots } from "../services/a2a-call.ts";
import { mockLogger } from "../test-setup.ts";
import { processMemoryExtractionBatch } from "../services/memory-extraction.ts";
import { cancelRun } from "../runs/run-cancel.ts";
import { stopCanceledA2aRuns } from "../services/a2a-cancel.ts";
import { recoverStuckChats } from "../jobs/scheduler.ts";

const CARD_PATH = "/.well-known/agent-card.json";

const seed = ({
  endpoint = {},
  gate = "all",
  allowed = false,
  ownerIsMember = true,
  tokens = [],
}: {
  endpoint?: Row;
  gate?: string;
  allowed?: boolean;
  ownerIsMember?: boolean;
  tokens?: Row[];
} = {}) =>
  seedDb({
    organization: [{ id: "org-1", name: "Acme", a2aGate: gate }],
    workspace: [
      {
        id: "ws-1",
        organizationId: "org-1",
        ownerId: "owner-1",
        name: "Support",
        a2aAllowed: allowed,
      },
    ],
    organization_member: ownerIsMember
      ? [
          {
            id: "m-1",
            organizationId: "org-1",
            userId: "owner-1",
            role: "member",
          },
        ]
      : [],
    agent: [
      {
        id: "agent-1",
        workspaceId: "ws-1",
        name: "Helper",
        description: "Internal: uses the CRM tools",
        toolSetIds: ["crm"],
        skillIds: ["refunds"],
      },
    ],
    a2a_endpoint: [
      {
        id: "ep-1",
        workspaceId: "ws-1",
        agentId: "agent-1",
        name: "Acme helpdesk",
        description: "Ask about your Acme order",
        enabled: true,
        ...endpoint,
      },
    ],
    a2a_token: tokens,
  });

const card = (endpointId = "ep-1") =>
  app.request(`/a2a/${endpointId}${CARD_PATH}`);

describe("GET /a2a/:endpointId/.well-known/agent-card.json", () => {
  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
  });

  it("serves the public card without a token", async () => {
    seed();

    const res = await card();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      name: "Acme helpdesk",
      description: "Ask about your Acme order",
      supportedInterfaces: [
        {
          url: "http://localhost:4001/a2a/ep-1",
          protocolBinding: "JSONRPC",
          protocolVersion: "1.0",
        },
      ],
      version: "1.0.0",
      capabilities: {
        streaming: true,
        pushNotifications: true,
        extendedAgentCard: true,
      },
      securitySchemes: {
        bearer: { httpAuthSecurityScheme: { scheme: "Bearer" } },
      },
      securityRequirements: [{ schemes: { bearer: { list: [] } } }],
      defaultInputModes: ["text/plain", "application/json"],
      defaultOutputModes: ["text/plain"],
      skills: [],
    });
  });

  it("never carries the Agent's own description, Tool sets or Skills", async () => {
    seed();

    const text = await (await card()).text();

    expect(text).not.toContain("Internal: uses the CRM tools");
    expect(text).not.toContain("crm");
    expect(text).not.toContain("refunds");
    expect(text).not.toContain("agent-1");
  });

  it("is served under a selected Workspace", async () => {
    seed({ gate: "selected", allowed: true });

    expect((await card()).status).toBe(200);
  });

  it.each([
    ["the endpoint is unknown", {}, "ep-unknown"],
    ["the endpoint is disabled", { endpoint: { enabled: false } }, "ep-1"],
    ["the gate is off", { gate: "off" }, "ep-1"],
    ["the gate excludes the Workspace", { gate: "selected" }, "ep-1"],
    ["the Owner has left the Organization", { ownerIsMember: false }, "ep-1"],
  ] as const)("is the same 404 when %s", async (_case, options, id) => {
    seed(options);

    const res = await card(id);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not Found" });
  });
});

describe("POST /a2a/:endpointId — the token", () => {
  const NOW = new Date("2026-10-04T12:00:00.000Z");
  const DAY = 24 * 60 * 60 * 1000;
  const TOKEN = "pa2a_the-right-token";

  const token = (over: Row = {}): Row => ({
    id: "tok-1",
    endpointId: "ep-1",
    name: "Hermes",
    tokenHash: hashInboundToken(TOKEN),
    tokenCreatedAt: new Date(NOW.getTime() - 10 * DAY),
    tokenExpiresAt: new Date(NOW.getTime() + 80 * DAY),
    tokenNotice: null,
    lastUsedAt: null,
    lastRejectedAt: null,
    createdAt: new Date(NOW.getTime() - 10 * DAY),
    ...over,
  });

  const call = (authorization?: string, endpointId = "ep-1") =>
    app.request(`/a2a/${endpointId}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(authorization ? { Authorization: authorization } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "GetTask" }),
    });

  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
    resetA2aTokenTouches();
    resetA2aRunSlots();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("lets a live token in and stamps last used", async () => {
    const fake = seed({ tokens: [token()] });

    const res = await call(`Bearer ${TOKEN}`);

    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(404);
    expect(fake.tables.a2a_token[0].lastUsedAt).toEqual(NOW);
  });

  it.each([
    ["missing", undefined],
    ["wrong", "Bearer pa2a_a-wrong-token"],
    ["not a bearer token", `Basic ${TOKEN}`],
  ])("is 401 when the token is %s", async (_case, authorization) => {
    const fake = seed({ tokens: [token()] });

    const res = await call(authorization);

    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBe("Bearer");
    // No token is named, so none is stamped.
    expect(fake.tables.a2a_token[0].lastRejectedAt).toBeNull();
  });

  it("is 401 for another endpoint's token", async () => {
    seed({ tokens: [token({ endpointId: "ep-2" })] });

    expect((await call(`Bearer ${TOKEN}`)).status).toBe(401);
  });

  it("is 401 for an expired token, stamps last rejected and tells the Owner once", async () => {
    const fake = seed({
      tokens: [token({ tokenExpiresAt: new Date(NOW.getTime() - DAY) })],
    });

    expect((await call(`Bearer ${TOKEN}`)).status).toBe(401);
    expect((await call(`Bearer ${TOKEN}`)).status).toBe(401);

    expect(createNotification).toHaveBeenCalledTimes(1);
    expect(createNotification).toHaveBeenCalledWith(
      expect.anything(),
      { orgId: "org-1", workspaceId: "ws-1", agentId: "agent-1" },
      expect.objectContaining({ title: "A2A token has expired" }),
    );
    const [stored] = fake.tables.a2a_token;
    expect(stored.tokenNotice).toBe("expired");
    expect(stored.lastRejectedAt).toEqual(NOW);
    expect(stored.lastUsedAt).toBeNull();
  });

  it("is the card's 404, not 401, when the endpoint isn't live", async () => {
    seed({ endpoint: { enabled: false }, tokens: [token()] });

    const res = await call(`Bearer ${TOKEN}`);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not Found" });
  });
});

// ---------------------------------------------------------------- JSON-RPC

const TOKEN = "pa2a_the-right-token";

let tables: Record<string, Row[]> = {};
/** A token's lifecycle columns, live for the next 90 days. */
const LIVE = {
  tokenCreatedAt: new Date(),
  tokenExpiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
  tokenNotice: null,
  lastUsedAt: null,
  lastRejectedAt: null,
};

const seedConversation = (rows: Record<string, Row[]> = {}) =>
  ({ tables } = seedDb(
    {
      organization: [{ id: "org-1", name: "Acme", a2aGate: "all" }],
      workspace: [
        {
          id: "ws-1",
          organizationId: "org-1",
          ownerId: "owner-1",
          name: "Support",
          a2aAllowed: false,
        },
      ],
      organization_member: [
        {
          id: "m-1",
          organizationId: "org-1",
          userId: "owner-1",
          role: "member",
        },
      ],
      user: [{ id: "owner-1", name: "Olive Owner" }],
      provider: [
        {
          id: "p-1",
          workspaceId: "ws-1",
          organizationId: null,
          name: "Test",
          providerType: "OpenAI",
          apiKey: "sk-test",
          apiMode: "responses",
          searchSource: "native",
          modelIds: ["gpt-test"],
          taskModelId: "gpt-test",
          memoryExtractionModelId: "gpt-test",
        },
      ],
      agent: [
        {
          id: "agent-1",
          workspaceId: "ws-1",
          providerId: "p-1",
          modelId: "gpt-test",
          name: "Helper",
          description: "Internal",
        },
        {
          id: "agent-2",
          workspaceId: "ws-1",
          providerId: "p-1",
          modelId: "gpt-test",
          name: "Other",
          description: "Other",
        },
      ],
      a2a_endpoint: [
        {
          id: "ep-1",
          workspaceId: "ws-1",
          agentId: "agent-1",
          name: "Acme helpdesk",
          description: "Ask about your Acme order",
          enabled: true,
        },
        {
          id: "ep-2",
          workspaceId: "ws-1",
          agentId: "agent-1",
          name: "Second",
          description: "Second",
          enabled: true,
        },
      ],
      a2a_token: [
        {
          id: "tok-1",
          endpointId: "ep-1",
          name: "Telegram via Hermes",
          tokenHash: hashInboundToken(TOKEN),
          ...LIVE,
        },
        {
          id: "tok-2",
          endpointId: "ep-2",
          name: "Rovo",
          tokenHash: hashInboundToken("pa2a_second-token"),
          ...LIVE,
        },
      ],
      ...rows,
    },
    {
      unique: {
        chat: [{ name: "chat_pkey", columns: ["id"] }],
        a2a_task: [
          {
            name: "idx_a2a_task_chat_id_message_id",
            columns: ["chatId", "messageId"],
          },
        ],
      },
    },
  ));

type RpcTask = {
  id: string;
  contextId: string;
  status: { state: string };
  artifacts: { parts: { text: string; mediaType?: string }[] }[];
};
type RpcBody = {
  result: RpcTask & {
    task: RpcTask;
    name?: string;
    skills?: unknown[];
  };
  error: { code: number; data: { metadata?: Record<string, string> }[] };
};

let rpcId = 0;
const rpc = async (
  method: string,
  params: unknown,
  {
    token = TOKEN,
    endpointId = "ep-1",
  }: { token?: string | null; endpointId?: string } = {},
) => {
  const res = await app.request(`/a2a/${endpointId}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  return { status: res.status, body: (await res.json()) as RpcBody };
};

const text = (value: string) => ({ text: value });

const send = (
  message: Record<string, unknown>,
  options: {
    returnImmediately?: boolean;
    token?: string;
    endpointId?: string;
  } = {},
) =>
  rpc(
    "SendMessage",
    {
      message: {
        role: "ROLE_USER",
        parts: [text("Where is my order?")],
        ...message,
      },
      configuration: { returnImmediately: options.returnImmediately ?? false },
    },
    options,
  );

const rows = (table: string) => tables[table] ?? [];

/** A Task whose run has written its first words and is held there. */
const startMidReply = async () => {
  model.holdMidReply = new Promise(() => {});
  const sent = await send({ messageId: "msg-a" }, { returnImmediately: true });
  await vi.waitFor(() => expect(model.prompts).toHaveLength(1));
  return sent.body.result.task;
};

/** The Chat moves on: the next turn is sent, and ends. */
const moveOn = async (contextId: string) => {
  model.holdMidReply = null;
  const next = await send({ messageId: "msg-b", contextId });
  expect(next.body.result.task.status.state).toBe("TASK_STATE_COMPLETED");
};

const stateOf = async (taskId: string) =>
  (await rpc("GetTask", { id: taskId })).body.result.status.state;

describe("POST /a2a/:endpointId (JSON-RPC)", () => {
  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
    model.reply = "Hello from Helper";
    model.hold = null;
    model.holdMidReply = null;
    model.prompts = [];
    resetA2aTokenTouches();
    resetA2aRunSlots();
  });

  it("stamps the token's last used on a SendMessage", async () => {
    seedConversation();

    await send({ messageId: "msg-a" });

    expect(rows("a2a_token")[0].lastUsedAt).toBeInstanceOf(Date);
  });

  it("is 401 for an expired token on SendMessage, and starts nothing", async () => {
    seedConversation();
    rows("a2a_token")[0].tokenExpiresAt = new Date(Date.now() - 1000);

    const res = await send({ messageId: "msg-a" });

    expect(res.status).toBe(401);
    expect(rows("a2a_token")[0].lastRejectedAt).toBeInstanceOf(Date);
    expect(rows("chat")).toHaveLength(0);
    expect(model.prompts).toHaveLength(0);
  });

  it.each([
    ["no token", null],
    ["a wrong token", "pa2a_wrong"],
    ["another endpoint's token", "pa2a_second-token"],
  ])("is 401 with %s", async (_case, token) => {
    seedConversation();

    const res = await rpc("GetTask", { id: "x" }, { token });

    expect(res.status).toBe(401);
  });

  it("is the card's 404 when the endpoint is not live", async () => {
    seedConversation({
      a2a_endpoint: [
        {
          id: "ep-1",
          workspaceId: "ws-1",
          agentId: "agent-1",
          name: "Off",
          description: "Off",
          enabled: false,
        },
      ],
    });

    const res = await rpc("GetTask", { id: "x" });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Not Found" });
  });

  it("answers an unknown method with method not found", async () => {
    seedConversation();

    const res = await rpc("DoSomething", {});

    expect(res.body.error.code).toBe(-32601);
  });

  it("adds one skill on the authenticated extended card", async () => {
    seedConversation();

    const res = await rpc("GetExtendedAgentCard", {});

    expect(res.body.result.name).toBe("Acme helpdesk");
    expect(res.body.result.skills).toEqual([
      expect.objectContaining({
        id: "ep-1",
        name: "Acme helpdesk",
        description: "Ask about your Acme order",
      }),
    ]);
  });

  it("starts a new Chat bound to the endpoint's Agent and answers with its Task", async () => {
    seedConversation();

    const res = await send({
      messageId: "msg-a",
      parts: [text("Where is my order?"), { data: { order: 42 } }],
    });

    const task = res.body.result.task;
    expect(task.status.state).toBe("TASK_STATE_COMPLETED");
    expect(task.artifacts[0].parts).toEqual([
      { text: "Hello from Helper", mediaType: "text/plain" },
    ]);
    const [chat] = rows("chat");
    expect(task.contextId).toBe(chat.id);
    expect(chat).toMatchObject({
      workspaceId: "ws-1",
      agentId: "agent-1",
      a2aTokenId: "tok-1",
      status: "succeeded",
    });
    expect(rows("chat_message")[0]).toMatchObject({
      id: "msg-a",
      role: "user",
      parts: [
        { type: "text", text: "Where is my order?" },
        { type: "text", text: 'Data:\n{\n  "order": 42\n}' },
      ],
    });
    expect(rows("a2a_task")).toEqual([
      expect.objectContaining({
        id: task.id,
        chatId: chat.id,
        messageId: "msg-a",
        endpointId: "ep-1",
        tokenId: "tok-1",
      }),
    ]);
  });

  describe("memory settings", () => {
    /** ep-1 with its memory settings, and one Memory of its Owner's. */
    const seedMemories = (settings: {
      includeMemories: boolean;
      extractMemories: boolean;
    }) => {
      seedConversation();
      Object.assign(rows("a2a_endpoint")[0], settings);
      rows("workspace")[0].memoryExtractionProviderId = "p-1";
      tables.memory_daily_summary = [
        {
          id: "sum-1",
          userId: "owner-1",
          workspaceId: "ws-1",
          summaryDate: new Date().toISOString().slice(0, 10),
          summary: "Olive is planning a trip to Lisbon",
        },
      ];
    };

    it("leaves the Owner's Memories out of the System prompt when includeMemories is off", async () => {
      seedMemories({ includeMemories: false, extractMemories: false });

      await send({ messageId: "msg-a" });

      expect(JSON.stringify(model.prompts[0])).not.toContain("Lisbon");
      expect(rows("chat")[0].memorySnapshot ?? null).toBeNull();
    });

    it("puts the Owner's Memories in the System prompt when includeMemories is on", async () => {
      seedMemories({ includeMemories: true, extractMemories: false });

      await send({ messageId: "msg-a" });

      expect(JSON.stringify(model.prompts[0])).toContain(
        "Olive is planning a trip to Lisbon",
      );
    });

    it.each([
      ["skips", false, undefined],
      ["extracts", true, "failed"],
    ])(
      "%s the endpoint's Chats in memory extraction when extractMemories is %s",
      async (_case, extractMemories, status) => {
        seedMemories({ includeMemories: false, extractMemories });
        await send({ messageId: "msg-a" });

        // The mocked model refuses to generate, so a Chat the pass reads
        // ends it failed; one it skips is never touched.
        await processMemoryExtractionBatch();

        expect(rows("chat")[0].memoryExtractionStatus).toBe(status);
      },
    );

    it("keeps skipping the endpoint's Chats once the endpoint is deleted", async () => {
      seedMemories({ includeMemories: false, extractMemories: false });
      await send({ messageId: "msg-a" });
      tables.a2a_endpoint = tables.a2a_endpoint.filter((e) => e.id !== "ep-1");
      tables.a2a_token = tables.a2a_token.filter((t) => t.id !== "tok-1");
      rows("chat")[0].a2aTokenId = null;

      await processMemoryExtractionBatch();

      expect(rows("chat")[0].memoryExtractionStatus).toBeUndefined();
    });
  });

  it("tells the Agent the turn arrives over A2A from the token's name", async () => {
    seedConversation();

    await send({ messageId: "msg-a" });

    expect(JSON.stringify(model.prompts[0])).toContain(
      'This conversation arrives over A2A from the client \\"Telegram via Hermes\\"',
    );
  });

  it("returns a working Task at once, which GetTask follows to its end", async () => {
    seedConversation();
    let release = () => {};
    model.hold = new Promise((resolve) => (release = resolve));

    const sent = await send(
      { messageId: "msg-a" },
      { returnImmediately: true },
    );
    const task = sent.body.result.task;
    expect(task.status.state).toBe("TASK_STATE_SUBMITTED");
    expect(task.artifacts).toBeUndefined();

    release();
    await vi.waitFor(async () => {
      const got = await rpc("GetTask", { id: task.id });
      expect(got.body.result.status.state).toBe("TASK_STATE_COMPLETED");
    });
    const got = await rpc("GetTask", { id: task.id });
    expect(got.body.result.artifacts[0].parts[0].text).toBe(
      "Hello from Helper",
    );
  });

  it("answers a retried messageId with the Task it already started", async () => {
    seedConversation();

    const first = await send({ messageId: "msg-a" });
    const retry = await send({ messageId: "msg-a" });
    const contextId = first.body.result.task.contextId;
    const retryInContext = await send({ messageId: "msg-a", contextId });

    expect(retry.body.result.task.id).toBe(first.body.result.task.id);
    expect(retryInContext.body.result.task.id).toBe(first.body.result.task.id);
    expect(model.prompts).toHaveLength(1);
    expect(rows("chat")).toHaveLength(1);
  });

  it("continues the Chat a contextId names, after its active leaf", async () => {
    seedConversation();
    const first = await send({ messageId: "msg-a" });
    const contextId = first.body.result.task.contextId;
    const reply = rows("chat_message").find((m) => m.role === "assistant")!;

    model.reply = "Second answer";
    const second = await send({ messageId: "msg-b", contextId });

    expect(second.body.result.task.contextId).toBe(contextId);
    expect(second.body.result.task.id).not.toBe(first.body.result.task.id);
    expect(second.body.result.task.artifacts[0].parts[0].text).toBe(
      "Second answer",
    );
    expect(rows("chat_message").find((m) => m.id === "msg-b")).toMatchObject({
      parentId: reply.id,
    });
    expect(rows("chat")).toHaveLength(1);
  });

  it.each([
    ["another Workspace", { workspaceId: "ws-2", agentId: "agent-1" }],
    ["another Agent", { workspaceId: "ws-1", agentId: "agent-2" }],
  ])("refuses a contextId of a Chat in %s", async (_case, chat) => {
    seedConversation({
      chat: [{ id: "chat-x", title: "Theirs", status: "succeeded", ...chat }],
    });

    const res = await send({ messageId: "msg-a", contextId: "chat-x" });

    expect(res.body.error.code).toBe(-32001);
    expect(model.prompts).toHaveLength(0);
  });

  it("refuses a message while the Owner's run is active, naming its Task", async () => {
    seedConversation({
      chat: [
        {
          id: "chat-1",
          workspaceId: "ws-1",
          agentId: "agent-1",
          title: "Busy",
          status: "running",
          activeLeafId: "owner-msg",
        },
      ],
      chat_message: [
        {
          chatId: "chat-1",
          id: "owner-msg",
          parentId: null,
          role: "user",
          parts: [{ type: "text", text: "Owner asks" }],
          deletedAt: null,
          createdAt: new Date(),
        },
      ],
    });

    const res = await send({ messageId: "msg-a", contextId: "chat-1" });

    expect(res.body.error.code).toBe(-32004);
    const [task] = rows("a2a_task");
    expect(task).toMatchObject({ chatId: "chat-1", messageId: "owner-msg" });
    expect(res.body.error.data[0].metadata).toEqual({ taskId: task.id });
    expect(model.prompts).toHaveLength(0);

    const got = await rpc("GetTask", { id: task.id });
    expect(got.body.result.status.state).toBe("TASK_STATE_SUBMITTED");
  });

  it("refuses a file part with an error, not a dropped part", async () => {
    seedConversation();

    const res = await send({
      messageId: "msg-a",
      parts: [
        text("see"),
        { url: "https://x.test/a.png", mediaType: "image/png" },
      ],
    });

    expect(res.body.error.code).toBe(-32005);
    expect(rows("chat")).toHaveLength(0);
  });

  describe("a Task that ended after writing part of a reply", () => {
    afterEach(() => vi.unstubAllEnvs());

    it("still reads canceled once the Chat has moved on", async () => {
      seedConversation();
      const task = await startMidReply();

      await cancelRun(task.contextId);
      await vi.waitFor(async () =>
        expect(await stateOf(task.id)).toBe("TASK_STATE_CANCELED"),
      );
      expect(rows("chat_message").some((m) => m.role === "assistant")).toBe(
        true,
      );
      await moveOn(task.contextId);

      expect(await stateOf(task.id)).toBe("TASK_STATE_CANCELED");
    });

    it("still reads failed once the Chat has moved on", async () => {
      // A run that outlives its bound ends failed.
      vi.stubEnv("CHAT_PER_RUN_TIMEOUT_MS", "300");
      seedConversation();
      const task = await startMidReply();

      await vi.waitFor(async () =>
        expect(await stateOf(task.id)).toBe("TASK_STATE_FAILED"),
      );
      expect(rows("chat_message").some((m) => m.role === "assistant")).toBe(
        true,
      );
      await moveOn(task.contextId);

      expect(await stateOf(task.id)).toBe("TASK_STATE_FAILED");
    });

    it("keeps the end of a Task made just as its run ended", async () => {
      // The run ended between the busy refusal and its Task being made, so
      // the run's end found no Task to record on.
      seedConversation({
        chat: [
          {
            id: "chat-1",
            workspaceId: "ws-1",
            agentId: "agent-1",
            title: "Ended",
            status: "cancelled",
            activeLeafId: "reply-a",
          },
        ],
        chat_message: [
          {
            chatId: "chat-1",
            id: "msg-a",
            parentId: null,
            role: "user",
            parts: [{ type: "text", text: "Where is my order?" }],
            deletedAt: null,
            createdAt: new Date(Date.now() - 1000),
          },
          {
            chatId: "chat-1",
            id: "reply-a",
            parentId: "msg-a",
            role: "assistant",
            parts: [{ type: "text", text: "Let me ch" }],
            deletedAt: null,
            createdAt: new Date(Date.now() - 1000),
          },
        ],
        a2a_task: [
          {
            id: "task-1",
            chatId: "chat-1",
            messageId: "msg-a",
            endpointId: "ep-1",
            tokenId: "tok-1",
            state: null,
            createdAt: new Date(),
          },
        ],
      });

      expect(await stateOf("task-1")).toBe("TASK_STATE_CANCELED");
      await moveOn("chat-1");

      expect(await stateOf("task-1")).toBe("TASK_STATE_CANCELED");
    });

    it("reads failed after the stuck-Chat sweep, once the Chat has moved on", async () => {
      const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
      seedConversation({
        chat: [
          {
            id: "chat-1",
            workspaceId: "ws-1",
            agentId: "agent-1",
            title: "Orphaned",
            status: "running",
            activeLeafId: "reply-a",
            lastTurnAt: hourAgo,
            updatedAt: hourAgo,
          },
        ],
        chat_message: [
          {
            chatId: "chat-1",
            id: "msg-a",
            parentId: null,
            role: "user",
            parts: [{ type: "text", text: "Where is my order?" }],
            deletedAt: null,
            createdAt: hourAgo,
          },
          {
            chatId: "chat-1",
            id: "reply-a",
            parentId: "msg-a",
            role: "assistant",
            parts: [{ type: "text", text: "Let me ch" }],
            deletedAt: null,
            createdAt: hourAgo,
          },
        ],
        a2a_task: [
          {
            id: "task-1",
            chatId: "chat-1",
            messageId: "msg-a",
            endpointId: "ep-1",
            tokenId: "tok-1",
            state: null,
            createdAt: hourAgo,
          },
        ],
      });
      vi.stubEnv("CHAT_PER_RUN_TIMEOUT_MS", "1000");

      await recoverStuckChats();
      vi.unstubAllEnvs();
      await vi.waitFor(() =>
        expect(rows("a2a_task")[0]).toMatchObject({ state: "failed" }),
      );
      await moveOn("chat-1");

      expect(await stateOf("task-1")).toBe("TASK_STATE_FAILED");
    });
  });

  it("does not read another endpoint's Task", async () => {
    seedConversation();
    const sent = await send({ messageId: "msg-a" });

    const res = await rpc(
      "GetTask",
      { id: sent.body.result.task.id },
      { endpointId: "ep-2", token: "pa2a_second-token" },
    );

    expect(res.body.error.code).toBe(-32001);
  });
});

/** A Chat whose run another instance holds: no process here can abort it. */
const seedRunElsewhere = () =>
  seedConversation({
    chat: [
      {
        id: "chat-1",
        workspaceId: "ws-1",
        agentId: "agent-1",
        title: "Elsewhere",
        status: "running",
        activeLeafId: "msg-a",
      },
    ],
    chat_message: [
      {
        chatId: "chat-1",
        id: "msg-a",
        parentId: null,
        role: "user",
        parts: [{ type: "text", text: "Where is my order?" }],
        deletedAt: null,
        createdAt: new Date(),
      },
    ],
    a2a_task: [
      {
        id: "task-1",
        chatId: "chat-1",
        messageId: "msg-a",
        endpointId: "ep-1",
        tokenId: "tok-1",
        state: null,
        createdAt: new Date(),
      },
    ],
  });

describe("POST /a2a/:endpointId — CancelTask", () => {
  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
    model.reply = "Hello from Helper";
    model.deltas = null;
    model.hold = null;
    model.holdMidReply = null;
    model.prompts = [];
    resetA2aTokenTouches();
    resetA2aRunSlots();
  });

  it("stops a running Task's run and answers with the Task, canceled", async () => {
    seedConversation();
    const task = await startMidReply();

    const res = await rpc("CancelTask", { id: task.id });

    expect(res.body.result).toMatchObject({
      id: task.id,
      contextId: task.contextId,
      status: { state: "TASK_STATE_CANCELED" },
    });
    expect(cancelRun).toHaveBeenCalledWith(task.contextId, {
      startedBefore: expect.any(Date) as unknown,
    });
    await vi.waitFor(() =>
      expect(rows("chat")[0]).toMatchObject({ status: "cancelled" }),
    );
    expect(await stateOf(task.id)).toBe("TASK_STATE_CANCELED");
  });

  it("cancels a run another instance holds, and reads canceled at once", async () => {
    seedRunElsewhere();
    vi.mocked(cancelRun).mockResolvedValueOnce();

    const res = await rpc("CancelTask", { id: "task-1" });

    expect(res.body.result.status.state).toBe("TASK_STATE_CANCELED");
    expect(cancelRun).toHaveBeenCalledWith("chat-1", {
      startedBefore: expect.any(Date) as unknown,
    });
    expect(rows("a2a_task")[0]).toMatchObject({
      state: "canceled",
      canceledAt: expect.any(Date) as unknown,
    });
    expect(await stateOf("task-1")).toBe("TASK_STATE_CANCELED");
  });

  it("stops a run whose cancel never reached it, on the next sweep", async () => {
    seedConversation();
    const task = await startMidReply();
    // Lost on its way, as while the listener reconnects.
    vi.mocked(cancelRun).mockResolvedValueOnce();

    await rpc("CancelTask", { id: task.id });
    expect(rows("chat")[0]).toMatchObject({ status: "running" });
    await stopCanceledA2aRuns();

    await vi.waitFor(() =>
      expect(rows("chat")[0]).toMatchObject({ status: "cancelled" }),
    );
    expect(await stateOf(task.id)).toBe("TASK_STATE_CANCELED");
  });

  it("never sweeps up the run of a later turn in the same Chat", async () => {
    seedConversation();
    const first = await startMidReply();
    await rpc("CancelTask", { id: first.id });
    await vi.waitFor(() =>
      expect(rows("chat")[0]).toMatchObject({ status: "cancelled" }),
    );
    const next = await send(
      { messageId: "msg-b", contextId: first.contextId },
      { returnImmediately: true },
    );
    await vi.waitFor(() => expect(model.prompts).toHaveLength(2));

    await stopCanceledA2aRuns();

    expect(rows("chat")[0]).toMatchObject({ status: "running" });
    expect(await stateOf(next.body.result.task.id)).toMatch(
      /SUBMITTED|WORKING/,
    );
    await rpc("CancelTask", { id: next.body.result.task.id });
  });

  it("answers a Task that has already ended with its final state, stopping nothing", async () => {
    seedConversation();
    const sent = await send({ messageId: "msg-a" });
    const taskId = sent.body.result.task.id;

    const res = await rpc("CancelTask", { id: taskId });

    expect(res.body.result.status.state).toBe("TASK_STATE_COMPLETED");
    expect(res.body.result.artifacts[0].parts[0].text).toBe(
      "Hello from Helper",
    );
    expect(cancelRun).not.toHaveBeenCalled();
    expect(await stateOf(taskId)).toBe("TASK_STATE_COMPLETED");
  });

  it("does not cancel another endpoint's Task", async () => {
    seedConversation();
    const task = await startMidReply();

    const res = await rpc(
      "CancelTask",
      { id: task.id },
      { endpointId: "ep-2", token: "pa2a_second-token" },
    );

    expect(res.body.error.code).toBe(-32001);
    expect(cancelRun).not.toHaveBeenCalled();
    expect(rows("chat")[0]).toMatchObject({ status: "running" });
    // Its own endpoint stops the held run, so it doesn't outlive the test.
    await rpc("CancelTask", { id: task.id });
  });
});

describe("POST /a2a/:endpointId — push notifications", () => {
  const PUSH_URL = "https://203.0.113.10/push";
  const push = vi.fn<typeof fetch>();
  /** A push config as a client registers it. */
  const config = (over: Record<string, unknown> = {}) => ({
    url: PUSH_URL,
    token: "client-verification-token",
    authentication: { scheme: "Bearer", credentials: "client-secret" },
    ...over,
  });

  type Pushed = {
    url: string;
    headers: Record<string, string>;
    body: { task: RpcTask };
  };
  const pushed = (): Pushed[] =>
    push.mock.calls.map(([url, init]) => ({
      url: url as string,
      headers: init?.headers as Record<string, string>,
      body: JSON.parse(init?.body as string) as { task: RpcTask },
    }));

  /** A Task left running: its model call waits until `release()`. */
  const startHeld = async () => {
    let release = () => {};
    model.hold = new Promise((resolve) => (release = resolve));
    const sent = await send(
      { messageId: "msg-a" },
      { returnImmediately: true },
    );
    return { task: sent.body.result.task, release };
  };

  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
    model.reply = "Hello from Helper";
    model.hold = null;
    model.holdMidReply = null;
    model.prompts = [];
    resetA2aTokenTouches();
    resetA2aRunSlots();
    push.mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", push);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("POSTs the finished Task with the client's credentials, and nothing before", async () => {
    seedConversation();
    const { task, release } = await startHeld();

    const created = await rpc("CreateTaskPushNotificationConfig", {
      taskId: task.id,
      ...config(),
    });
    expect(created.body.result).toMatchObject({
      taskId: task.id,
      url: PUSH_URL,
    });
    // Still running: nothing is pushed for an intermediate state.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(push).not.toHaveBeenCalled();

    release();
    await vi.waitFor(() => expect(push).toHaveBeenCalledTimes(1));
    const [call] = pushed();
    expect(call.url).toBe(PUSH_URL);
    expect(call.headers).toMatchObject({
      "Content-Type": "application/a2a+json",
      Authorization: "Bearer client-secret",
      "X-A2A-Notification-Token": "client-verification-token",
    });
    expect(call.body.task).toMatchObject({
      id: task.id,
      contextId: task.contextId,
      status: { state: "TASK_STATE_COMPLETED" },
    });
    expect(call.body.task.artifacts[0].parts[0].text).toBe("Hello from Helper");
    // No message content leaks into what the server signs or logs: only the
    // client's own config is stored.
    expect(rows("a2a_push_config")).toEqual([
      expect.objectContaining({ taskId: task.id, url: PUSH_URL }),
    ]);
  });

  it("registers a config sent with SendMessage and pushes once when the Task ends", async () => {
    seedConversation();

    const sent = await rpc("SendMessage", {
      message: {
        role: "ROLE_USER",
        messageId: "msg-a",
        parts: [text("Where is my order?")],
      },
      configuration: {
        returnImmediately: false,
        taskPushNotificationConfig: config(),
      },
    });

    const task = sent.body.result.task;
    expect(task.status.state).toBe("TASK_STATE_COMPLETED");
    await vi.waitFor(() => expect(push).toHaveBeenCalledTimes(1));
    expect(pushed()[0].body.task.id).toBe(task.id);
    // However the end is noticed — the run's end or the registration — it is
    // pushed once.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(push).toHaveBeenCalledTimes(1);
  });

  it("pushes at once when a config is registered on a Task that already ended", async () => {
    seedConversation();
    const sent = await send({ messageId: "msg-a" });
    const task = sent.body.result.task;

    await rpc("CreateTaskPushNotificationConfig", {
      taskId: task.id,
      ...config(),
    });

    await vi.waitFor(() => expect(push).toHaveBeenCalledTimes(1));
    expect(pushed()[0].body.task.status.state).toBe("TASK_STATE_COMPLETED");
  });

  it("pushes a failed Task", async () => {
    // A run that outlives its bound ends failed.
    vi.stubEnv("CHAT_PER_RUN_TIMEOUT_MS", "300");
    seedConversation();
    const { task, release } = await startHeld();
    await rpc("CreateTaskPushNotificationConfig", {
      taskId: task.id,
      ...config(),
    });

    await vi.waitFor(() => expect(push).toHaveBeenCalledTimes(1));
    release();
    expect(pushed()[0].body.task.status.state).toBe("TASK_STATE_FAILED");
  });

  it("pushes a canceled Task", async () => {
    seedConversation();
    const { task, release } = await startHeld();
    await rpc("CreateTaskPushNotificationConfig", {
      taskId: task.id,
      ...config(),
    });

    await cancelRun(task.contextId);
    release();

    await vi.waitFor(() => expect(push).toHaveBeenCalledTimes(1));
    expect(pushed()[0].body.task.status.state).toBe("TASK_STATE_CANCELED");
  });

  it("pushes a Task canceled with CancelTask once, though another instance holds its run", async () => {
    seedRunElsewhere();
    vi.mocked(cancelRun).mockResolvedValueOnce();
    await rpc("CreateTaskPushNotificationConfig", {
      taskId: "task-1",
      ...config(),
    });

    await rpc("CancelTask", { id: "task-1" });
    await rpc("CancelTask", { id: "task-1" });

    await vi.waitFor(() => expect(push).toHaveBeenCalledTimes(1));
    expect(pushed()[0].body.task.status.state).toBe("TASK_STATE_CANCELED");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(push).toHaveBeenCalledTimes(1);
  });

  it("pushes the stored end to a URL registered after the Chat moved on", async () => {
    seedConversation();
    const task = await startMidReply();
    await cancelRun(task.contextId);
    await vi.waitFor(async () =>
      expect(await stateOf(task.id)).toBe("TASK_STATE_CANCELED"),
    );
    await moveOn(task.contextId);

    await rpc("CreateTaskPushNotificationConfig", {
      taskId: task.id,
      ...config(),
    });

    await vi.waitFor(() => expect(push).toHaveBeenCalledTimes(1));
    expect(pushed()[0].body.task).toMatchObject({
      id: task.id,
      status: { state: "TASK_STATE_CANCELED" },
    });
  });

  it("pushes once however often the same config is registered", async () => {
    seedConversation();
    const sent = await send({ messageId: "msg-a" });
    const task = sent.body.result.task;

    await rpc("CreateTaskPushNotificationConfig", {
      taskId: task.id,
      ...config(),
    });
    await vi.waitFor(() => expect(push).toHaveBeenCalledTimes(1));
    await rpc("CreateTaskPushNotificationConfig", {
      taskId: task.id,
      ...config(),
    });
    await send({ messageId: "msg-a" });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(push).toHaveBeenCalledTimes(1);
    expect(rows("a2a_push_config")).toHaveLength(1);
  });

  it("pushes a Task whose run died with its instance, without holding up the sweep", async () => {
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
    seedConversation({
      chat: [
        {
          id: "chat-1",
          workspaceId: "ws-1",
          agentId: "agent-1",
          title: "Orphaned",
          status: "running",
          activeLeafId: "msg-a",
          lastTurnAt: hourAgo,
          updatedAt: hourAgo,
        },
      ],
      chat_message: [
        {
          chatId: "chat-1",
          id: "msg-a",
          parentId: null,
          role: "user",
          parts: [{ type: "text", text: "Where is my order?" }],
          deletedAt: null,
          createdAt: hourAgo,
        },
      ],
      a2a_task: [
        {
          id: "task-1",
          chatId: "chat-1",
          messageId: "msg-a",
          endpointId: "ep-1",
          tokenId: "tok-1",
          createdAt: hourAgo,
        },
      ],
      a2a_push_config: [
        {
          id: "cfg-1",
          taskId: "task-1",
          url: PUSH_URL,
          token: null,
          authentication: null,
          notifiedAt: null,
          createdAt: hourAgo,
        },
      ],
    });
    vi.stubEnv("CHAT_PER_RUN_TIMEOUT_MS", "1000");
    // The client's server has not answered yet.
    let answer = () => {};
    push.mockReturnValueOnce(
      new Promise((resolve) => {
        answer = () => resolve(new Response(null, { status: 200 }));
      }),
    );

    // Resolves while the push is still in flight.
    await recoverStuckChats();

    await vi.waitFor(() => expect(push).toHaveBeenCalledTimes(1));
    answer();
    expect(pushed()[0].body.task).toMatchObject({
      id: "task-1",
      status: { state: "TASK_STATE_FAILED" },
    });
  });

  it("retries a delivery the client's server refused", async () => {
    seedConversation();
    push.mockResolvedValueOnce(new Response(null, { status: 503 }));
    const { task, release } = await startHeld();
    await rpc("CreateTaskPushNotificationConfig", {
      taskId: task.id,
      ...config(),
    });

    release();

    await vi.waitFor(() => expect(push).toHaveBeenCalledTimes(2), {
      timeout: 3000,
    });
  });

  it("refuses a URL the network policy blocks, and never calls it", async () => {
    seedConversation();
    const { task, release } = await startHeld();

    const res = await rpc("CreateTaskPushNotificationConfig", {
      taskId: task.id,
      ...config({ url: "http://169.254.169.254/latest/meta-data" }),
    });

    expect(res.body.error.code).toBe(-32602);
    expect(rows("a2a_push_config")).toHaveLength(0);
    release();
    await vi.waitFor(async () => {
      const got = await rpc("GetTask", { id: task.id });
      expect(got.body.result.status.state).toBe("TASK_STATE_COMPLETED");
    });
    expect(push).not.toHaveBeenCalled();
  });

  it("refuses authentication missing its scheme or its credentials", async () => {
    seedConversation();
    const { task, release } = await startHeld();

    for (const authentication of [
      { scheme: "Bearer", credentials: "" },
      { scheme: "", credentials: "client-secret" },
    ]) {
      const res = await rpc("CreateTaskPushNotificationConfig", {
        taskId: task.id,
        ...config({ authentication }),
      });
      expect(res.body.error.code).toBe(-32602);
    }

    expect(rows("a2a_push_config")).toHaveLength(0);
    release();
  });

  it("gets, lists and deletes a Task's configs; a deleted one is not pushed", async () => {
    seedConversation();
    const { task, release } = await startHeld();
    const created = await rpc("CreateTaskPushNotificationConfig", {
      taskId: task.id,
      id: "cfg-1",
      ...config(),
    });
    expect(created.body.result).toMatchObject({ id: "cfg-1" });

    const got = await rpc("GetTaskPushNotificationConfig", {
      taskId: task.id,
      id: "cfg-1",
    });
    expect(got.body.result).toMatchObject({
      id: "cfg-1",
      taskId: task.id,
      url: PUSH_URL,
    });
    const listed = await rpc("ListTaskPushNotificationConfigs", {
      taskId: task.id,
    });
    expect(listed.body.result).toMatchObject({
      configs: [expect.objectContaining({ id: "cfg-1" })],
    });

    await rpc("DeleteTaskPushNotificationConfig", {
      taskId: task.id,
      id: "cfg-1",
    });
    const gone = await rpc("GetTaskPushNotificationConfig", {
      taskId: task.id,
      id: "cfg-1",
    });
    expect(gone.body.error.code).toBe(-32001);

    release();
    await vi.waitFor(async () => {
      const read = await rpc("GetTask", { id: task.id });
      expect(read.body.result.status.state).toBe("TASK_STATE_COMPLETED");
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(push).not.toHaveBeenCalled();
  });

  it("does not register a config on another endpoint's Task", async () => {
    seedConversation();
    const sent = await send({ messageId: "msg-a" });

    const res = await rpc(
      "CreateTaskPushNotificationConfig",
      { taskId: sent.body.result.task.id, ...config() },
      { endpointId: "ep-2", token: "pa2a_second-token" },
    );

    expect(res.body.error.code).toBe(-32001);
    expect(rows("a2a_push_config")).toHaveLength(0);
  });
});

describe("POST /a2a/:endpointId — the load cap", () => {
  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
    model.reply = "Hello from Helper";
    model.hold = null;
    model.prompts = [];
    resetA2aTokenTouches();
    resetA2aRunSlots();
    process.env.A2A_MAX_CONCURRENT_RUNS = "1";
  });

  afterEach(() => {
    delete process.env.A2A_MAX_CONCURRENT_RUNS;
  });

  it("answers 429 with Retry-After past the cap, writing no Chat or Task", async () => {
    seedConversation();
    let release = () => {};
    model.hold = new Promise((resolve) => (release = resolve));
    await send({ messageId: "msg-a" }, { returnImmediately: true });

    const res = await app.request("/a2a/ep-1", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "SendMessage",
        params: {
          message: {
            messageId: "msg-b",
            role: "ROLE_USER",
            parts: [text("Another question")],
          },
        },
      }),
    });

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("30");
    expect(await res.json()).toEqual({ error: "Too Many Requests" });
    expect(rows("chat")).toHaveLength(1);
    expect(rows("a2a_task")).toHaveLength(1);
    expect(model.prompts).toHaveLength(1);
    release();
  });

  it("still answers a retry, and GetTask, while at the cap", async () => {
    seedConversation();
    let release = () => {};
    model.hold = new Promise((resolve) => (release = resolve));
    const first = await send(
      { messageId: "msg-a" },
      { returnImmediately: true },
    );

    const retry = await send(
      { messageId: "msg-a" },
      { returnImmediately: true },
    );
    const got = await rpc("GetTask", { id: first.body.result.task.id });

    expect(retry.status).toBe(200);
    expect(retry.body.result.task.id).toBe(first.body.result.task.id);
    expect(got.body.result.id).toBe(first.body.result.task.id);
    release();
  });

  it("frees the slot when the run ends", async () => {
    seedConversation();
    let release = () => {};
    model.hold = new Promise((resolve) => (release = resolve));
    const first = await send(
      { messageId: "msg-a" },
      { returnImmediately: true },
    );
    release();
    await vi.waitFor(async () => {
      const got = await rpc("GetTask", { id: first.body.result.task.id });
      expect(got.body.result.status.state).toBe("TASK_STATE_COMPLETED");
    });

    await vi.waitFor(() => expect(activeA2aRunCount()).toBe(0));
    const next = await send({ messageId: "msg-b" });

    expect(next.status).toBe(200);
    expect(next.body.result.task.status.state).toBe("TASK_STATE_COMPLETED");
  });

  it("frees the slot when the turn is refused before it runs", async () => {
    seedConversation({
      chat: [
        {
          id: "chat-1",
          workspaceId: "ws-1",
          agentId: "agent-1",
          title: "Busy",
          status: "running",
          activeLeafId: null,
        },
      ],
    });

    const busy = await send({ messageId: "msg-a", contextId: "chat-1" });
    const next = await send({ messageId: "msg-b" });

    expect(busy.body.error.code).toBe(-32004);
    expect(next.status).toBe(200);
    expect(next.body.result.task.status.state).toBe("TASK_STATE_COMPLETED");
  });

  it("answers a SendStreamingMessage past the cap with 429, not a stream", async () => {
    seedConversation();
    let release = () => {};
    model.hold = new Promise((resolve) => (release = resolve));
    await send({ messageId: "msg-a" }, { returnImmediately: true });

    const res = await app.request("/a2a/ep-1", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "SendStreamingMessage",
        params: {
          message: {
            messageId: "msg-b",
            role: "ROLE_USER",
            parts: [text("Another question")],
          },
        },
      }),
    });

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("30");
    expect(rows("a2a_task")).toHaveLength(1);
    release();
  });
});

describe("POST /a2a/:endpointId — the body cap", () => {
  /** A SendMessage whose body is well past a 64-byte cap. */
  const oversized = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "SendMessage",
    params: {
      message: {
        messageId: "msg-big",
        role: "ROLE_USER",
        parts: [text("x".repeat(200))],
      },
    },
  });

  const post = (body: BodyInit, token: string | null = TOKEN) =>
    app.request("/a2a/ep-1", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body,
      // A streamed body carries no Content-Length.
      ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
    });

  const callLogLines = () =>
    mockLogger.info.mock.calls
      .filter(([, message]) => message === "A2A call")
      .map(([fields]) => fields as Record<string, unknown>);

  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
    model.reply = "Hello from Helper";
    model.hold = null;
    model.prompts = [];
    resetA2aTokenTouches();
    resetA2aRunSlots();
    process.env.A2A_MAX_BODY_BYTES = "64";
  });

  afterEach(() => {
    delete process.env.A2A_MAX_BODY_BYTES;
  });

  it.each([
    ["a live token", TOKEN],
    ["a wrong token", "pa2a_a-wrong-token"],
    ["no token", null],
  ])(
    "answers 413 with %s, before the token is checked",
    async (_case, token) => {
      seedConversation();

      const res = await post(oversized, token);
      // A token stamp is not awaited by the route; let one land if sent.
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(res.status).toBe(413);
      expect(await res.json()).toEqual({ error: "Payload Too Large" });
      expect(rows("chat")).toEqual([]);
      expect(rows("a2a_task")).toEqual([]);
      expect(model.prompts).toEqual([]);
      expect(rows("a2a_token")[0].lastUsedAt).toBeNull();
      expect(rows("a2a_token")[0].lastRejectedAt).toBeNull();
    },
  );

  it("answers 413 to a streamed body with no Content-Length", async () => {
    seedConversation();
    const bytes = new TextEncoder().encode(oversized);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 50));
        controller.enqueue(bytes.slice(50));
        controller.close();
      },
    });

    const res = await post(stream);

    expect(res.status).toBe(413);
    expect(rows("a2a_task")).toEqual([]);
  });

  it("logs the 413 once, with the endpoint's ids and no token", async () => {
    seedConversation();

    await post(oversized);

    expect(callLogLines()).toEqual([
      {
        organizationId: "org-1",
        workspaceId: "ws-1",
        endpointId: "ep-1",
        tokenId: null,
        method: null,
        outcome: "rejected",
        reason: "body_too_large",
        taskId: null,
        chatId: null,
      },
    ]);
  });

  it("answers a body within the cap as usual", async () => {
    process.env.A2A_MAX_BODY_BYTES = "65536";
    seedConversation();

    const sent = await send({ messageId: "msg-a" });

    expect(sent.status).toBe(200);
    expect(sent.body.result.task.id).toBeDefined();
  });

  it("leaves the Agent Card alone", async () => {
    seedConversation();

    const res = await card();

    expect(res.status).toBe(200);
    expect(callLogLines()).toEqual([
      expect.objectContaining({ method: "GetAgentCard", outcome: "ok" }),
    ]);
  });
});

describe("the A2A call log", () => {
  /** The call-log lines written so far, as their field objects. */
  const callLogLines = () =>
    mockLogger.info.mock.calls
      .filter(([, message]) => message === "A2A call")
      .map(([fields]) => fields as Record<string, unknown>);

  /** Every field, `null` where the call did not reach it. */
  const line = (fields: Record<string, unknown>) => ({
    organizationId: null,
    workspaceId: null,
    endpointId: "ep-1",
    tokenId: null,
    method: null,
    outcome: "ok",
    reason: null,
    taskId: null,
    chatId: null,
    ...fields,
  });

  const ids = { organizationId: "org-1", workspaceId: "ws-1" };

  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
    model.reply = "Hello from Helper";
    model.hold = null;
    model.prompts = [];
    resetA2aTokenTouches();
    resetA2aRunSlots();
  });

  afterEach(() => {
    delete process.env.A2A_MAX_CONCURRENT_RUNS;
  });

  it("logs a card fetch", async () => {
    seedConversation();

    await card();

    expect(callLogLines()).toEqual([line({ ...ids, method: "GetAgentCard" })]);
  });

  it.each([
    ["unknown_endpoint", "ep-nope", {}, {}],
    ["disabled", "ep-1", { enabled: false }, ids],
  ])(
    "logs a card fetch from an endpoint that isn't live as %s",
    async (reason, endpointId, endpoint, known) => {
      seed({ endpoint });

      await card(endpointId);

      expect(callLogLines()).toEqual([
        line({
          ...known,
          endpointId,
          method: "GetAgentCard",
          outcome: "rejected",
          reason,
        }),
      ]);
    },
  );

  it("logs a closed gate and an Owner who has left", async () => {
    seed({ gate: "off" });
    await card();
    resetMockDb();
    seed({ ownerIsMember: false });
    await card();

    expect(callLogLines().map((l) => l.reason)).toEqual(["gate", "owner_left"]);
    expect(callLogLines()[0]).toMatchObject(ids);
  });

  it("logs a SendMessage with its token, Task and Chat, and no message content", async () => {
    seedConversation();

    const sent = await send({ messageId: "msg-a" });

    const { id: taskId, contextId: chatId } = sent.body.result.task;
    expect(callLogLines()).toEqual([
      line({
        ...ids,
        tokenId: "tok-1",
        method: "SendMessage",
        taskId,
        chatId,
      }),
    ]);
    const everything = JSON.stringify(mockLogger.info.mock.calls);
    expect(everything).not.toContain("Where is my order?");
    expect(everything).not.toContain("Hello from Helper");
  });

  it("logs a GetTask with its Task and Chat", async () => {
    seedConversation();
    const sent = await send({ messageId: "msg-a" });
    vi.clearAllMocks();

    await rpc("GetTask", { id: sent.body.result.task.id });

    expect(callLogLines()).toEqual([
      line({
        ...ids,
        tokenId: "tok-1",
        method: "GetTask",
        taskId: sent.body.result.task.id,
        chatId: sent.body.result.task.contextId,
      }),
    ]);
  });

  it.each([
    ["missing_token", null],
    ["bad_token", "pa2a_a-wrong-token"],
  ])("logs a %s", async (reason, token) => {
    seedConversation();

    await rpc("GetTask", { id: "t" }, { token });

    expect(callLogLines()).toEqual([
      line({ ...ids, method: "GetTask", outcome: "rejected", reason }),
    ]);
  });

  it("logs an expired token with the token it names", async () => {
    seedConversation();
    rows("a2a_token")[0].tokenExpiresAt = new Date(Date.now() - 1000);

    await rpc("GetTask", { id: "t" });

    expect(callLogLines()).toEqual([
      line({
        ...ids,
        tokenId: "tok-1",
        method: "GetTask",
        outcome: "rejected",
        reason: "expired_token",
      }),
    ]);
  });

  it("logs an A2A error by its kind", async () => {
    seedConversation();

    await rpc("GetTask", { id: "no-such-task" });
    await rpc("NoSuchMethod", {});
    await send({
      messageId: "msg-a",
      parts: [{ url: "https://x.test/a.png", mediaType: "image/png" }],
    });

    expect(callLogLines()).toEqual([
      line({
        ...ids,
        tokenId: "tok-1",
        method: "GetTask",
        outcome: "rejected",
        reason: "task_not_found",
      }),
      line({
        ...ids,
        tokenId: "tok-1",
        method: "NoSuchMethod",
        outcome: "rejected",
        reason: "method_not_found",
      }),
      line({
        ...ids,
        tokenId: "tok-1",
        method: "SendMessage",
        outcome: "rejected",
        reason: "content_type_not_supported",
      }),
    ]);
  });

  it("logs a body that isn't JSON", async () => {
    seedConversation();

    await app.request("/a2a/ep-1", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
      body: "not json",
    });

    expect(callLogLines()).toEqual([
      line({
        ...ids,
        tokenId: "tok-1",
        outcome: "rejected",
        reason: "invalid_params",
      }),
    ]);
  });

  it("logs a message refused while the Chat is busy, with the Task it names", async () => {
    seedConversation({
      chat: [
        {
          id: "chat-1",
          workspaceId: "ws-1",
          agentId: "agent-1",
          title: "Busy",
          status: "running",
          activeLeafId: "owner-msg",
        },
      ],
      chat_message: [
        {
          chatId: "chat-1",
          id: "owner-msg",
          parentId: null,
          role: "user",
          parts: [{ type: "text", text: "Owner asks" }],
          deletedAt: null,
          createdAt: new Date(),
        },
      ],
    });

    await send({ messageId: "msg-a", contextId: "chat-1" });

    expect(callLogLines()).toEqual([
      line({
        ...ids,
        tokenId: "tok-1",
        method: "SendMessage",
        outcome: "rejected",
        reason: "busy",
        taskId: rows("a2a_task")[0].id,
      }),
    ]);
  });

  it("logs a call past the load cap as rate limited", async () => {
    process.env.A2A_MAX_CONCURRENT_RUNS = "1";
    seedConversation();
    let release = () => {};
    model.hold = new Promise((resolve) => (release = resolve));
    await send({ messageId: "msg-a" }, { returnImmediately: true });
    vi.clearAllMocks();

    await send({ messageId: "msg-b" }, { returnImmediately: true });

    expect(callLogLines()).toEqual([
      line({
        ...ids,
        tokenId: "tok-1",
        method: "SendMessage",
        outcome: "rate_limited",
      }),
    ]);
    release();
  });

  it("logs a SendStreamingMessage once, with its Task and Chat", async () => {
    seedConversation();

    const res = await app.request("/a2a/ep-1", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "SendStreamingMessage",
        params: {
          message: {
            messageId: "msg-a",
            role: "ROLE_USER",
            parts: [text("Where is my order?")],
          },
        },
      }),
    });
    await res.text();

    expect(callLogLines()).toEqual([
      line({
        ...ids,
        tokenId: "tok-1",
        method: "SendStreamingMessage",
        taskId: rows("a2a_task")[0].id,
        chatId: rows("chat")[0].id,
      }),
    ]);
  });

  it("logs an internal error without its detail", async () => {
    // A stored reply that doesn't read as parts fails inside the backend.
    seedConversation({
      chat: [
        {
          id: "chat-1",
          workspaceId: "ws-1",
          agentId: "agent-1",
          title: "Broken",
          status: "succeeded",
          activeLeafId: "reply-1",
        },
      ],
      chat_message: [
        {
          chatId: "chat-1",
          id: "reply-1",
          parentId: "msg-a",
          role: "assistant",
          parts: "secret detail",
          deletedAt: null,
          createdAt: new Date(),
        },
      ],
      a2a_task: [
        {
          id: "task-1",
          chatId: "chat-1",
          messageId: "msg-a",
          endpointId: "ep-1",
          tokenId: "tok-1",
          createdAt: new Date(),
        },
      ],
    });

    const res = await rpc("GetTask", { id: "task-1" });

    expect(res.body.error.code).toBe(-32603);
    expect(callLogLines()).toEqual([
      line({
        ...ids,
        tokenId: "tok-1",
        method: "GetTask",
        outcome: "rejected",
        reason: "internal_error",
      }),
    ]);
  });
});

describe("POST /a2a/:endpointId — streaming", () => {
  type StreamEvent = {
    task?: RpcTask;
    statusUpdate?: {
      taskId: string;
      contextId: string;
      status: { state: string };
    };
    artifactUpdate?: {
      taskId: string;
      append?: boolean;
      lastChunk?: boolean;
      artifact: { artifactId: string; parts: { text: string }[] };
    };
  };

  /** Opens a streaming call; the response comes back once its first event is ready. */
  const open = (
    method: string,
    params: unknown,
    {
      token = TOKEN,
      endpointId = "ep-1",
    }: { token?: string; endpointId?: string } = {},
  ) =>
    app.request(`/a2a/${endpointId}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
    });

  /** Every event of a stream, read to its end. */
  const eventsOf = async (res: Response) =>
    (await res.text())
      .split("\n\n")
      .filter((frame) => frame.startsWith("data: "))
      .map(
        (frame) =>
          (JSON.parse(frame.slice(6)) as { result: StreamEvent }).result,
      );

  const streamSend = (message: Record<string, unknown>) =>
    open("SendStreamingMessage", {
      message: {
        role: "ROLE_USER",
        parts: [text("Where is my order?")],
        ...message,
      },
    });

  const artifactUpdates = (events: StreamEvent[]) =>
    events.flatMap((e) => (e.artifactUpdate ? [e.artifactUpdate] : []));

  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
    model.reply = "Hello from Helper";
    model.deltas = null;
    model.hold = null;
    model.holdMidReply = null;
    model.prompts = [];
    resetA2aTokenTouches();
  });

  it("streams the reply as artifact updates, from the Task to its completed status", async () => {
    seedConversation();
    model.deltas = ["Hello ", "from ", "Helper"];

    const res = await streamSend({ messageId: "msg-a" });

    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const events = await eventsOf(res);
    const task = events[0].task!;
    expect(task.contextId).toBe(rows("chat")[0].id);
    expect(task.status.state).toMatch(/SUBMITTED|WORKING/);

    const updates = artifactUpdates(events);
    expect(updates.slice(0, 3).map((u) => u.artifact.parts[0].text)).toEqual([
      "Hello ",
      "from ",
      "Helper",
    ]);
    expect(updates.slice(0, 3).map((u) => u.append ?? false)).toEqual([
      false,
      true,
      true,
    ]);
    // The finished artifact replaces the streamed one, under the same id.
    const final = updates.at(-1)!;
    expect(final.append ?? false).toBe(false);
    expect(final.lastChunk).toBe(true);
    expect(final.artifact.parts[0].text).toBe("Hello from Helper");
    expect(new Set(updates.map((u) => u.artifact.artifactId)).size).toBe(1);

    expect(events.at(-1)!.statusUpdate).toMatchObject({
      taskId: task.id,
      contextId: task.contextId,
      status: { state: "TASK_STATE_COMPLETED" },
    });
    for (const e of events.slice(1)) {
      expect((e.statusUpdate ?? e.artifactUpdate)!.taskId).toBe(task.id);
    }
    const got = await rpc("GetTask", { id: task.id });
    expect(got.body.result.status.state).toBe("TASK_STATE_COMPLETED");
  });

  it("keeps the run going when the client hangs up", async () => {
    seedConversation();
    let release = () => {};
    model.hold = new Promise((resolve) => (release = resolve));

    const res = await streamSend({ messageId: "msg-a" });
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    const first = new TextDecoder().decode(value);
    const taskId = (
      JSON.parse(first.slice("data: ".length)) as { result: StreamEvent }
    ).result.task!.id;
    await reader.cancel();
    release();

    await vi.waitFor(async () => {
      const got = await rpc("GetTask", { id: taskId });
      expect(got.body.result.status.state).toBe("TASK_STATE_COMPLETED");
    });
  });

  it("answers a refused message with a JSON-RPC error, not a stream", async () => {
    seedConversation();

    const res = await streamSend({
      messageId: "msg-a",
      parts: [{ url: "https://x.test/a.png", mediaType: "image/png" }],
    });

    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as RpcBody;
    expect(body.error.code).toBe(-32005);
    expect(rows("chat")).toHaveLength(0);
  });

  it("answers a retried messageId with its Task, without a second run", async () => {
    seedConversation();
    const first = await send({ messageId: "msg-a" });

    const events = await eventsOf(await streamSend({ messageId: "msg-a" }));

    expect(events).toHaveLength(1);
    expect(events[0].task).toMatchObject({
      id: first.body.result.task.id,
      status: { state: "TASK_STATE_COMPLETED" },
    });
    expect(model.prompts).toHaveLength(1);
  });

  it("follows a running Task on SubscribeToTask, with no token deltas", async () => {
    seedConversation();
    model.deltas = ["Hello ", "from ", "Helper"];
    let release = () => {};
    model.hold = new Promise((resolve) => (release = resolve));
    const sent = await send(
      { messageId: "msg-a" },
      { returnImmediately: true },
    );
    const taskId = sent.body.result.task.id;

    const res = await open("SubscribeToTask", { id: taskId });
    release();
    const events = await eventsOf(res);

    expect(events[0].task!.id).toBe(taskId);
    const updates = artifactUpdates(events);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ taskId, lastChunk: true });
    expect(updates[0].artifact.parts[0].text).toBe("Hello from Helper");
    expect(events.at(-1)!.statusUpdate!.status.state).toBe(
      "TASK_STATE_COMPLETED",
    );
  });

  it("follows a Task from the database alone, as another instance would", async () => {
    // A run no process here holds: only its rows say how it goes.
    seedConversation({
      chat: [
        {
          id: "chat-1",
          workspaceId: "ws-1",
          agentId: "agent-1",
          title: "Elsewhere",
          status: "running",
          activeLeafId: "msg-a",
        },
      ],
      chat_message: [
        {
          chatId: "chat-1",
          id: "msg-a",
          parentId: null,
          role: "user",
          parts: [{ type: "text", text: "Where is my order?" }],
          deletedAt: null,
          createdAt: new Date(),
        },
      ],
      a2a_task: [
        {
          id: "task-1",
          chatId: "chat-1",
          messageId: "msg-a",
          endpointId: "ep-1",
          tokenId: "tok-1",
          createdAt: new Date(),
        },
      ],
    });

    const res = await open("SubscribeToTask", { id: "task-1" });
    rows("chat_message").push({
      chatId: "chat-1",
      id: "reply-1",
      parentId: "msg-a",
      role: "assistant",
      parts: [{ type: "text", text: "On its way" }],
      deletedAt: null,
      createdAt: new Date(),
    });
    Object.assign(rows("chat")[0], {
      status: "succeeded",
      activeLeafId: "reply-1",
    });
    const events = await eventsOf(res);

    expect(events[0].task).toMatchObject({
      id: "task-1",
      status: { state: "TASK_STATE_SUBMITTED" },
    });
    const updates = artifactUpdates(events);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      taskId: "task-1",
      artifact: { artifactId: "reply-1", parts: [{ text: "On its way" }] },
    });
    expect(events.at(-1)!.statusUpdate!.status.state).toBe(
      "TASK_STATE_COMPLETED",
    );
  });

  it("ends a SendStreamingMessage stream canceled when its Task is canceled", async () => {
    seedConversation();
    model.holdMidReply = new Promise(() => {});

    const res = await streamSend({ messageId: "msg-a" });
    await vi.waitFor(() => expect(model.prompts).toHaveLength(1));
    const taskId = rows("a2a_task")[0].id as string;
    await rpc("CancelTask", { id: taskId });
    const events = await eventsOf(res);

    expect(events.at(-1)!.statusUpdate).toMatchObject({
      taskId,
      status: { state: "TASK_STATE_CANCELED" },
    });
  });

  it("ends a SubscribeToTask stream canceled, though another instance holds the run", async () => {
    seedRunElsewhere();
    vi.mocked(cancelRun).mockResolvedValueOnce();

    const res = await open("SubscribeToTask", { id: "task-1" });
    await rpc("CancelTask", { id: "task-1" });
    const events = await eventsOf(res);

    expect(events[0].task!.status.state).toBe("TASK_STATE_SUBMITTED");
    expect(events.at(-1)!.statusUpdate).toMatchObject({
      taskId: "task-1",
      status: { state: "TASK_STATE_CANCELED" },
    });
    // The run never stopped here: the Task's recorded end ended the stream.
    expect(rows("chat")[0]).toMatchObject({ status: "running" });
  });

  it("refuses to subscribe to a Task that has ended", async () => {
    seedConversation();
    const sent = await send({ messageId: "msg-a" });

    const res = await open("SubscribeToTask", { id: sent.body.result.task.id });

    expect(res.headers.get("content-type")).toContain("application/json");
    expect(((await res.json()) as RpcBody).error.code).toBe(-32004);
  });

  it("does not subscribe to another endpoint's Task", async () => {
    seedConversation();
    let release = () => {};
    model.hold = new Promise((resolve) => (release = resolve));
    const sent = await send(
      { messageId: "msg-a" },
      { returnImmediately: true },
    );

    const res = await open(
      "SubscribeToTask",
      { id: sent.body.result.task.id },
      { endpointId: "ep-2", token: "pa2a_second-token" },
    );
    release();

    expect(((await res.json()) as RpcBody).error.code).toBe(-32001);
  });
});
