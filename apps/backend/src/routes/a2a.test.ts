import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { MockLanguageModelV3, convertArrayToReadableStream } from "ai/test";
import { resetMockDb, seedDb, type Row } from "../test-utils.ts";

// The model is the only thing mocked: everything from the JSON-RPC call to
// the Chat rows runs for real against the in-memory database.
const { model } = vi.hoisted(() => ({
  model: {
    reply: "Hello from Helper",
    hold: null as Promise<void> | null,
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
            { type: "text-delta", id: "t1", delta: model.reply },
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
          return { stream: convertArrayToReadableStream(chunks) };
        },
        doGenerate: () => Promise.reject(new Error("no titling in tests")),
      }),
    embeddingModel: () => {
      throw new Error("no embeddings in tests");
    },
  }),
}));

vi.mock("../services/notification.ts", () => ({
  createNotification: vi.fn(() => Promise.resolve({ id: "notification-1" })),
}));

import app from "../server.ts";
import { createNotification } from "../services/notification.ts";
import { hashInboundToken } from "../services/inbound-trigger-token.ts";
import { resetA2aTokenTouches } from "../services/a2a-token.ts";

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
        streaming: false,
        pushNotifications: false,
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

describe("POST /a2a/:endpointId (JSON-RPC)", () => {
  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
    model.reply = "Hello from Helper";
    model.hold = null;
    model.prompts = [];
    resetA2aTokenTouches();
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
