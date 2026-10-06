import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockSession, resetMockDb, seedDb, type Row } from "../test-utils.ts";
import { mockNanoid } from "../test-setup.ts";
import { hashBearerToken } from "../services/bearer-token.ts";
import app from "../server.ts";

const baseUrl = "/organizations/org-1/workspaces/ws-1/a2a-endpoints";
const createdAt = new Date("2026-09-01T00:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const farFuture = new Date("2099-01-01T00:00:00.000Z");

const liveToken = (over: Row = {}): Row => ({
  id: "tok-1",
  endpointId: "ep-1",
  name: "Hermes",
  tokenHash: "h",
  tokenCreatedAt: createdAt,
  tokenExpiresAt: farFuture,
  tokenNotice: null,
  lastUsedAt: null,
  lastRejectedAt: null,
  createdAt,
  ...over,
});

const endpoint = (over: Row = {}): Row => ({
  id: "ep-1",
  workspaceId: "ws-1",
  agentId: "agent-1",
  name: "Support",
  description: "Answers support questions",
  enabled: true,
  createdAt,
  updatedAt: createdAt,
  ...over,
});

/**
 * The caller is `user-1`. By default they own `ws-1`; `owner: "user-2"` makes
 * them an Org Admin looking at someone else's Workspace.
 */
const seed = ({
  role = "member",
  owner = "user-1",
  endpoints = [endpoint()],
  tokens = [],
}: {
  role?: "admin" | "member";
  owner?: string;
  endpoints?: Row[];
  tokens?: Row[];
} = {}) => {
  mockSession();
  return seedDb({
    organization_member: [
      { id: "m1", userId: "user-1", organizationId: "org-1", role },
    ],
    workspace: [
      { id: "ws-1", organizationId: "org-1", ownerId: owner, name: "Support" },
      { id: "ws-2", organizationId: "org-1", ownerId: owner, name: "Other" },
    ],
    agent: [
      {
        id: "agent-1",
        workspaceId: "ws-1",
        organizationId: null,
        name: "Helper",
        description: "Internal: uses the CRM tools",
      },
      {
        id: "agent-shared",
        workspaceId: null,
        organizationId: "org-1",
        name: "Shared helper",
        description: "Shared internal description",
      },
      {
        id: "agent-elsewhere",
        workspaceId: "ws-2",
        organizationId: null,
        name: "Not here",
        description: "Another Workspace's Agent",
      },
    ],
    attachment: [
      {
        id: "att-1",
        workspaceId: "ws-1",
        resourceType: "agent",
        resourceId: "agent-shared",
      },
    ],
    a2a_endpoint: endpoints,
    a2a_token: tokens,
  });
};

const send = (path: string, method: string, body?: unknown) =>
  app.request(`${baseUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

describe("A2A endpoint routes", () => {
  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
  });

  describe("as the Owner", () => {
    it("lists the Workspace's endpoints", async () => {
      seed({
        endpoints: [endpoint(), endpoint({ id: "ep-2", workspaceId: "ws-2" })],
      });

      const res = await app.request(baseUrl);

      expect(res.status).toBe(200);
      const body = (await res.json()) as { results: Row[] };
      expect(body.results.map((e: Row) => e.id)).toEqual(["ep-1"]);
    });

    it("creates an endpoint under a minted id, defaulting name and description to the Agent's", async () => {
      mockNanoid.mockReturnValueOnce("minted-endpoint-id-0001");
      const fake = seed({ endpoints: [] });

      const res = await send("", "POST", { agentId: "agent-1" });

      expect(res.status).toBe(201);
      const body = (await res.json()) as Row;
      expect(body).toMatchObject({
        id: "minted-endpoint-id-0001",
        agentId: "agent-1",
        workspaceId: "ws-1",
        name: "Helper",
        description: "Internal: uses the CRM tools",
        enabled: true,
      });
      expect(body.id).not.toBe("agent-1");
      expect(fake.tables.a2a_endpoint).toHaveLength(1);
    });

    it("creates an endpoint for an attached Shared Agent with its own public name", async () => {
      const fake = seed({ endpoints: [] });

      const res = await send("", "POST", {
        agentId: "agent-shared",
        name: "Acme helpdesk",
        description: "Ask about your Acme order",
      });

      expect(res.status).toBe(201);
      expect(fake.tables.a2a_endpoint[0]).toMatchObject({
        agentId: "agent-shared",
        name: "Acme helpdesk",
        description: "Ask about your Acme order",
      });
    });

    it("refuses an Agent that isn't usable in this Workspace", async () => {
      const fake = seed({ endpoints: [] });

      const res = await send("", "POST", { agentId: "agent-elsewhere" });

      expect(res.status).toBe(404);
      expect(fake.tables.a2a_endpoint).toHaveLength(0);
    });

    it("updates the public name, description and enabled switch", async () => {
      const fake = seed();

      const res = await send("/ep-1", "PUT", {
        name: "Renamed",
        description: "New public text",
        enabled: false,
      });

      expect(res.status).toBe(200);
      expect(fake.tables.a2a_endpoint[0]).toMatchObject({
        name: "Renamed",
        description: "New public text",
        enabled: false,
        agentId: "agent-1",
      });
    });

    it("creates an endpoint with both memory settings off unless set", async () => {
      const fake = seed({ endpoints: [] });

      await send("", "POST", { agentId: "agent-1" });
      await send("", "POST", {
        agentId: "agent-1",
        includeMemories: true,
        extractMemories: true,
      });

      expect(fake.tables.a2a_endpoint).toEqual([
        expect.objectContaining({
          includeMemories: false,
          extractMemories: false,
        }),
        expect.objectContaining({
          includeMemories: true,
          extractMemories: true,
        }),
      ]);
    });

    it("updates the memory settings", async () => {
      const fake = seed({
        endpoints: [
          endpoint({ includeMemories: false, extractMemories: false }),
        ],
      });

      const res = await send("/ep-1", "PUT", {
        includeMemories: true,
        extractMemories: true,
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        includeMemories: true,
        extractMemories: true,
      });
      expect(fake.tables.a2a_endpoint[0]).toMatchObject({
        includeMemories: true,
        extractMemories: true,
      });
    });

    it("ignores an attempt to move the endpoint to another Agent", async () => {
      const fake = seed();

      const res = await send("/ep-1", "PUT", { agentId: "agent-shared" });

      expect(res.status).toBe(200);
      expect(fake.tables.a2a_endpoint[0].agentId).toBe("agent-1");
    });

    it("404s an endpoint in another Workspace", async () => {
      seed({ endpoints: [endpoint({ workspaceId: "ws-2" })] });

      expect((await app.request(`${baseUrl}/ep-1`)).status).toBe(404);
      expect((await send("/ep-1", "PUT", { name: "x" })).status).toBe(404);
      expect((await send("/ep-1", "DELETE")).status).toBe(404);
    });

    // Its tokens go by the foreign key's cascade; `a2a-endpoint-cascade.test.ts`
    // checks that against real Postgres.
    it("deletes an endpoint", async () => {
      const fake = seed();

      const res = await send("/ep-1", "DELETE");

      expect(res.status).toBe(200);
      expect(fake.tables.a2a_endpoint).toHaveLength(0);
    });

    it("issues a named token, shown once and stored only as its hash", async () => {
      mockNanoid.mockReturnValueOnce("tok-1");
      const fake = seed();

      const res = await send("/ep-1/tokens", "POST", {
        name: "Hermes on Telegram",
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as { token: string };
      expect(body).toMatchObject({ id: "tok-1", name: "Hermes on Telegram" });
      expect(body.token).toMatch(/^pa2a_/);
      const [stored] = fake.tables.a2a_token;
      expect(stored.tokenHash).toBe(hashBearerToken(body.token));
      expect(Object.values(stored)).not.toContain(body.token);

      // Never readable again.
      const detail = (await (await app.request(`${baseUrl}/ep-1`)).json()) as {
        tokens: Row[];
      };
      expect(detail.tokens).toEqual([
        expect.objectContaining({ id: "tok-1", name: "Hermes on Telegram" }),
      ]);
      expect(JSON.stringify(detail)).not.toContain(body.token);
      expect(JSON.stringify(detail)).not.toContain(stored.tokenHash as string);
    });

    it("issues a token for 90 days by default, or for the lifetime picked", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(createdAt);
      try {
        const fake = seed();

        await send("/ep-1/tokens", "POST", { name: "Default" });
        await send("/ep-1/tokens", "POST", { name: "Short", expiryDays: 30 });
        const refused = await send("/ep-1/tokens", "POST", {
          name: "Odd",
          expiryDays: 45,
        });

        expect(refused.status).toBe(400);
        expect(
          fake.tables.a2a_token.map((t) => [t.name, t.tokenExpiresAt]),
        ).toEqual([
          ["Default", new Date(createdAt.getTime() + 90 * DAY)],
          ["Short", new Date(createdAt.getTime() + 30 * DAY)],
        ]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("lists each token's expiry, status, last used and last rejected", async () => {
      seed({ tokens: [liveToken({ lastUsedAt: createdAt })] });

      const detail = (await (await app.request(`${baseUrl}/ep-1`)).json()) as {
        tokens: Row[];
      };

      expect(detail.tokens).toEqual([
        {
          id: "tok-1",
          endpointId: "ep-1",
          name: "Hermes",
          tokenStatus: "active",
          tokenCreatedAt: createdAt.toISOString(),
          tokenExpiresAt: farFuture.toISOString(),
          lastUsedAt: createdAt.toISOString(),
          lastRejectedAt: null,
          createdAt: createdAt.toISOString(),
        },
      ]);
    });

    it("regenerates a token: the new value once, the old one dead, the reminders cleared", async () => {
      const fake = seed({
        tokens: [
          liveToken({
            tokenHash: hashBearerToken("pa2a_old"),
            tokenCreatedAt: createdAt,
            tokenExpiresAt: new Date(createdAt.getTime() + 30 * DAY),
            tokenNotice: "expired",
          }),
        ],
      });

      fake.queries.length = 0;
      const res = await send("/ep-1/tokens/tok-1/regenerate", "POST");

      expect(res.status).toBe(200);
      // One write, with the endpoint's Workspace checked in it.
      expect(
        fake.queries.filter(
          (q) => q.table === "a2a_token" || q.table === "a2a_endpoint",
        ),
      ).toEqual([{ kind: "update", table: "a2a_token" }]);
      const body = (await res.json()) as Row & { token: string };
      expect(body.token).toMatch(/^pa2a_/);
      expect(body).toMatchObject({ id: "tok-1", name: "Hermes" });
      expect(body).not.toHaveProperty("tokenHash");
      const [stored] = fake.tables.a2a_token;
      expect(stored.tokenHash).toBe(hashBearerToken(body.token));
      expect(stored.tokenHash).not.toBe(hashBearerToken("pa2a_old"));
      expect(stored.tokenNotice).toBeNull();
      // The same lifetime as before, from now.
      const created = (stored.tokenCreatedAt as Date).getTime();
      expect((stored.tokenExpiresAt as Date).getTime() - created).toBe(
        30 * DAY,
      );
      expect(created).toBeGreaterThan(createdAt.getTime());
    });

    it("404s regenerating a token on another endpoint or Workspace", async () => {
      const fake = seed({
        endpoints: [endpoint(), endpoint({ id: "ep-2", workspaceId: "ws-2" })],
        tokens: [liveToken({ endpointId: "ep-2", tokenHash: "h" })],
      });

      expect((await send("/ep-1/tokens/tok-1/regenerate", "POST")).status).toBe(
        404,
      );
      expect((await send("/ep-2/tokens/tok-1/regenerate", "POST")).status).toBe(
        404,
      );
      expect(fake.tables.a2a_token[0].tokenHash).toBe("h");
    });

    it("deletes a token", async () => {
      const fake = seed({
        tokens: [
          {
            id: "tok-1",
            endpointId: "ep-1",
            name: "Hermes",
            tokenHash: "h",
            createdAt,
          },
          {
            id: "tok-2",
            endpointId: "ep-1",
            name: "Rovo",
            tokenHash: "h2",
            createdAt,
          },
        ],
      });

      const res = await send("/ep-1/tokens/tok-1", "DELETE");

      expect(res.status).toBe(200);
      expect(fake.tables.a2a_token.map((t) => t.id)).toEqual(["tok-2"]);
    });

    it("404s a token on another Workspace's endpoint", async () => {
      const fake = seed({
        endpoints: [endpoint({ workspaceId: "ws-2" })],
        tokens: [
          {
            id: "tok-1",
            endpointId: "ep-1",
            name: "Hermes",
            tokenHash: "h",
            createdAt,
          },
        ],
      });

      expect((await send("/ep-1/tokens", "POST", { name: "x" })).status).toBe(
        404,
      );
      expect((await send("/ep-1/tokens/tok-1", "DELETE")).status).toBe(404);
      expect(fake.tables.a2a_token).toHaveLength(1);
    });
  });

  describe("as an Org Admin in another Owner's Workspace", () => {
    it("reads the endpoints", async () => {
      seed({ role: "admin", owner: "user-2" });

      expect((await app.request(baseUrl)).status).toBe(200);
      expect((await app.request(`${baseUrl}/ep-1`)).status).toBe(200);
    });

    it("can't create, edit or delete endpoints or tokens", async () => {
      const fake = seed({
        role: "admin",
        owner: "user-2",
        tokens: [
          {
            id: "tok-1",
            endpointId: "ep-1",
            name: "Hermes",
            tokenHash: "h",
            createdAt,
          },
        ],
      });

      expect((await send("", "POST", { agentId: "agent-1" })).status).toBe(403);
      expect((await send("/ep-1", "PUT", { name: "x" })).status).toBe(403);
      expect((await send("/ep-1", "DELETE")).status).toBe(403);
      expect((await send("/ep-1/tokens", "POST", { name: "x" })).status).toBe(
        403,
      );
      expect((await send("/ep-1/tokens/tok-1", "DELETE")).status).toBe(403);
      expect((await send("/ep-1/tokens/tok-1/regenerate", "POST")).status).toBe(
        403,
      );
      expect(fake.tables.a2a_endpoint).toEqual([endpoint()]);
      expect(fake.tables.a2a_token[0].tokenHash).toBe("h");
      expect(fake.tables.a2a_token).toHaveLength(1);
    });
  });
});
