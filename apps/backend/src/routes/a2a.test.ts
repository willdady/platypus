import { describe, it, expect, beforeEach, vi } from "vitest";
import { resetMockDb, seedDb, type Row } from "../test-utils.ts";
import app from "../server.ts";

const CARD_PATH = "/.well-known/agent-card.json";

const seed = ({
  endpoint = {},
  gate = "all",
  allowed = false,
  ownerIsMember = true,
}: {
  endpoint?: Row;
  gate?: string;
  allowed?: boolean;
  ownerIsMember?: boolean;
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
