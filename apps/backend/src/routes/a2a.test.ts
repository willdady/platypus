import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetMockDb, seedDb, type Row } from "../test-utils.ts";

vi.mock("../services/notification.ts", () => ({
  createNotification: vi.fn(() => Promise.resolve({ id: "notification-1" })),
}));

import { createNotification } from "../services/notification.ts";
import { hashInboundToken } from "../services/inbound-trigger-token.ts";
import { resetA2aTokenTouches } from "../services/a2a-token.ts";
import app from "../server.ts";

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
        extendedAgentCard: false,
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
