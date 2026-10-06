import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockSession, resetMockDb, seedDb, type Row } from "../test-utils.ts";
import { hashBearerToken } from "../services/bearer-token.ts";
import app from "../server.ts";

const baseUrl = "/organizations/org-1/a2a/endpoints";
const createdAt = new Date("2026-09-01T00:00:00.000Z");
/** When `tok-1`'s current value was issued: the marker a revoke names. */
const issuedAt = new Date("2026-09-02T00:00:00.000Z");
const expiresAt = new Date("2099-01-01T00:00:00.000Z");
const lastRejectedAt = new Date("2026-09-03T00:00:00.000Z");
const tokenUrl = (path: string, seen: Date | string = issuedAt) =>
  `${baseUrl}${path}?tokenCreatedAt=${seen instanceof Date ? seen.toISOString() : seen}`;

/** `user-1` is the caller, with `role` in `org-1`; `user-2` owns `ws-1`. */
const seed = (role: "admin" | "member" = "admin") => {
  mockSession();
  return seedDb({
    organization_member: [
      { id: "m1", userId: "user-1", organizationId: "org-1", role },
    ],
    organization: [{ id: "org-1", name: "Acme" }],
    user: [
      { id: "user-1", name: "Ada Admin" },
      { id: "user-2", name: "Dana Owner" },
    ],
    workspace: [
      {
        id: "ws-1",
        organizationId: "org-1",
        ownerId: "user-2",
        name: "Support",
      },
      { id: "ws-x", organizationId: "org-2", ownerId: "user-2", name: "Away" },
    ],
    agent: [
      { id: "agent-1", workspaceId: "ws-1", name: "Helper" },
      { id: "agent-x", workspaceId: "ws-x", name: "Elsewhere" },
    ],
    a2a_endpoint: [
      {
        id: "ep-1",
        workspaceId: "ws-1",
        agentId: "agent-1",
        name: "Support desk",
        description: "Answers support questions",
        enabled: true,
        createdAt,
        updatedAt: createdAt,
      },
      {
        id: "ep-x",
        workspaceId: "ws-x",
        agentId: "agent-x",
        name: "Other org",
        description: "Not this Organization's",
        enabled: true,
        createdAt,
        updatedAt: createdAt,
      },
    ],
    a2a_token: [
      {
        id: "tok-1",
        endpointId: "ep-1",
        name: "Telegram",
        tokenHash: "secret-hash",
        tokenCreatedAt: issuedAt,
        tokenExpiresAt: expiresAt,
        tokenNotice: "expiring_30",
        lastUsedAt: null,
        lastRejectedAt,
        createdAt,
      },
      {
        id: "tok-x",
        endpointId: "ep-x",
        name: "Elsewhere",
        tokenHash: "other-hash",
        tokenCreatedAt: issuedAt,
        tokenExpiresAt: expiresAt,
        createdAt,
      },
    ],
    notification: [],
  });
};

describe("Org A2A endpoint oversight routes", () => {
  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
  });

  it("lists every endpoint in the Organization with its tokens and how each stands, never a token's hash", async () => {
    seed();

    const res = await app.request(baseUrl);

    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown;
    expect(body).toEqual({
      results: [
        {
          id: "ep-1",
          name: "Support desk",
          enabled: true,
          agentId: "agent-1",
          agentName: "Helper",
          workspaceId: "ws-1",
          workspaceName: "Support",
          ownerId: "user-2",
          ownerName: "Dana Owner",
          createdAt: createdAt.toISOString(),
          tokens: [
            {
              id: "tok-1",
              endpointId: "ep-1",
              name: "Telegram",
              tokenCreatedAt: issuedAt.toISOString(),
              tokenExpiresAt: expiresAt.toISOString(),
              tokenStatus: "active",
              lastUsedAt: null,
              lastRejectedAt: lastRejectedAt.toISOString(),
              createdAt: createdAt.toISOString(),
            },
          ],
        },
      ],
    });
    expect(JSON.stringify(body)).not.toContain("secret-hash");
  });

  it("revokes an endpoint, deleting it, and notifies the Owner", async () => {
    const fake = seed();

    const res = await app.request(`${baseUrl}/ep-1`, { method: "DELETE" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ message: "A2A endpoint revoked" });
    expect(fake.tables.a2a_endpoint.map((e: Row) => e.id)).toEqual(["ep-x"]);
    expect(fake.tables.notification).toEqual([
      expect.objectContaining({
        workspaceId: "ws-1",
        agentId: "agent-1",
        title: "A2A endpoint revoked",
        body: expect.stringContaining('"Support desk"') as unknown,
      }),
    ]);
  });

  it("revokes a token, deleting it, and notifies the Owner", async () => {
    const fake = seed();

    const res = await app.request(tokenUrl("/ep-1/tokens/tok-1"), {
      method: "DELETE",
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ message: "A2A token revoked" });
    expect(fake.tables.a2a_token.map((t: Row) => t.id)).toEqual(["tok-x"]);
    expect(fake.tables.a2a_endpoint).toHaveLength(2);
    expect(fake.tables.notification).toEqual([
      expect.objectContaining({
        workspaceId: "ws-1",
        agentId: "agent-1",
        title: "A2A token revoked",
        body: expect.stringContaining('"Telegram"') as unknown,
      }),
    ]);
  });

  describe("as the endpoint's clients find it", () => {
    const TOKEN = "pa2a_telegram";
    const OTHER = "pa2a_rovo";

    /**
     * org-1 admits ep-1's Workspace, whose Owner is a member, and ep-1 has a
     * second client's token, tok-2: both clients' calls are answered.
     */
    const seedClients = () => {
      const fake = seed();
      fake.tables.organization[0].a2aGate = "all";
      fake.tables.organization_member.push({
        id: "m2",
        userId: "user-2",
        organizationId: "org-1",
        role: "member",
      });
      fake.tables.a2a_token[0].tokenHash = hashBearerToken(TOKEN);
      fake.tables.a2a_token.push({
        ...fake.tables.a2a_token[0],
        id: "tok-2",
        name: "Rovo",
        tokenHash: hashBearerToken(OTHER),
      });
      return fake;
    };

    /** A client's `GetTask` for a Task no one has: a live call's answer is -32001. */
    const call = async (token: string) => {
      const res = await app.request("/a2a/ep-1", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "GetTask",
          params: { id: "task-x" },
        }),
      });
      return { status: res.status, body: (await res.json()) as unknown };
    };

    const answered = {
      status: 200,
      body: expect.objectContaining({
        error: expect.objectContaining({ code: -32001 }) as unknown,
      }) as unknown,
    };

    it("answers a revoked token's client 401, and the endpoint's other clients as before", async () => {
      seedClients();
      expect(await call(TOKEN)).toEqual(answered);

      const res = await app.request(tokenUrl("/ep-1/tokens/tok-1"), {
        method: "DELETE",
      });

      expect(res.status).toBe(200);
      expect(await call(TOKEN)).toEqual({
        status: 401,
        body: { error: "Unauthorized" },
      });
      expect(await call(OTHER)).toEqual(answered);
    });

    it("answers every client of a revoked endpoint with the unknown endpoint's 404", async () => {
      seedClients();
      expect(await call(TOKEN)).toEqual(answered);

      const res = await app.request(`${baseUrl}/ep-1`, { method: "DELETE" });

      expect(res.status).toBe(200);
      for (const token of [TOKEN, OTHER]) {
        expect(await call(token)).toEqual({
          status: 404,
          body: { error: "Not Found" },
        });
      }
    });
  });

  it.each([
    ["an endpoint in another Organization", "/ep-x"],
    ["a token in another Organization", tokenUrl("/ep-x/tokens/tok-x")],
    ["a token under another endpoint", tokenUrl("/ep-1/tokens/tok-x")],
    ["an unknown endpoint", "/ep-nope"],
  ])("404s a revoke of %s and changes nothing", async (_, path) => {
    const fake = seed();

    const res = await app.request(
      path.startsWith(baseUrl) ? path : `${baseUrl}${path}`,
      { method: "DELETE" },
    );

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: expect.any(String) as unknown });
    expect(fake.tables.a2a_endpoint).toHaveLength(2);
    expect(fake.tables.a2a_token).toHaveLength(2);
    expect(fake.tables.notification).toEqual([]);
  });

  it("409s a token revoke when the token was regenerated since the list loaded, and keeps it", async () => {
    const fake = seed();

    const res = await app.request(
      tokenUrl("/ep-1/tokens/tok-1", new Date("2026-08-01T00:00:00.000Z")),
      { method: "DELETE" },
    );

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: expect.stringContaining(
        "replaced since you loaded the list",
      ) as unknown,
    });
    expect(fake.tables.a2a_token).toHaveLength(2);
    expect(fake.tables.notification).toEqual([]);
  });

  it.each(["", "?tokenCreatedAt=", "?tokenCreatedAt=yesterday"])(
    "400s a token revoke that doesn't name the token (%s)",
    async (query) => {
      const fake = seed();

      const res = await app.request(`${baseUrl}/ep-1/tokens/tok-1${query}`, {
        method: "DELETE",
      });

      expect(res.status).toBe(400);
      expect(fake.tables.a2a_token).toHaveLength(2);
    },
  );

  it.each([
    ["GET", ""],
    ["DELETE", "/ep-1"],
    ["DELETE", `/ep-1/tokens/tok-1?tokenCreatedAt=${issuedAt.toISOString()}`],
  ])(
    "refuses %s %s to a member who is not an Org Admin",
    async (method, path) => {
      const fake = seed("member");

      const res = await app.request(`${baseUrl}${path}`, { method });

      expect(res.status).toBe(403);
      expect(fake.tables.a2a_endpoint).toHaveLength(2);
      expect(fake.tables.a2a_token).toHaveLength(2);
    },
  );
});
