import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  mockDb,
  mockSession,
  resetMockDb,
  seedDb,
  type FakeDb,
  type Row,
} from "../test-utils.ts";
import app from "../server.ts";
import { auth as mcpAuth } from "@ai-sdk/mcp";

vi.mock("@ai-sdk/mcp", () => ({
  experimental_createMCPClient: vi.fn().mockResolvedValue({
    tools: vi.fn().mockResolvedValue({ tool1: {} }),
    close: vi.fn().mockResolvedValue(undefined),
  }),
  auth: vi.fn(),
}));

describe("Organization MCP Routes", () => {
  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
    mockDb.where.mockReturnValue(mockDb);
  });

  const orgId = "org-1";
  const baseUrl = `/organizations/${orgId}/mcps`;

  const json = (method: string, body: unknown) => ({
    method,
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });

  const createBody = {
    name: "Org MCP",
    url: "http://mcp.com",
    authType: "None",
    organizationId: orgId,
  };

  /** A Shared MCP of `org-1`, carrying every stored credential. */
  const sharedMcp = (over: Row = {}): Row => ({
    id: "mcp-1",
    name: "Org MCP",
    slug: "org_mcp",
    url: "http://mcp.example.com",
    authType: "OAuth",
    bearerToken: "bearer-secret",
    headers: { "X-Api-Key": "header-secret" },
    oauthAccessToken: "access-old",
    oauthRefreshToken: "refresh-old",
    oauthClientId: "client-id",
    oauthClientSecret: "client-secret",
    organizationId: orgId,
    workspaceId: null,
    ...over,
  });

  /**
   * The caller (`user-1`) is a member of `org-1` at `role`. Alongside `org-1`'s
   * Shared MCP sit two it must never reach from this surface: another
   * Organization's Shared MCP, and a Workspace-scoped MCP of its own org.
   */
  const world = (role: "admin" | "member" = "admin"): FakeDb =>
    seedDb({
      organization_member: [
        { id: "m1", userId: "user-1", organizationId: orgId, role },
      ],
      workspace: [{ id: "ws-1", organizationId: orgId, ownerId: "user-1" }],
      mcp: [
        sharedMcp(),
        sharedMcp({ id: "mcp-other-org", organizationId: "org-2" }),
        sharedMcp({
          id: "mcp-ws",
          organizationId: null,
          workspaceId: "ws-1",
        }),
      ],
    });

  const tokensOf = (fake: FakeDb, id: string) => {
    const row = fake.tables.mcp.find((m) => m.id === id)!;
    return [row.oauthAccessToken, row.oauthRefreshToken];
  };

  describe("POST /", () => {
    it("creates an org MCP if org admin", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([]); // assertMcpSlugAvailable — no conflict

      const mockMcp = {
        id: "mcp-1",
        name: "Org MCP",
        organizationId: orgId,
        authType: "None",
      };
      mockDb.returning.mockResolvedValueOnce([mockMcp]);

      const res = await app.request(baseUrl, json("POST", createBody));

      expect(res.status).toBe(201);
      expect(await res.json()).toEqual(mockMcp);
    });

    it("returns 403 if not org admin", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess

      const res = await app.request(baseUrl, json("POST", createBody));

      expect(res.status).toBe(403);
      expect(mockDb.insert).not.toHaveBeenCalled();
    });

    it("returns 409 if an MCP name already exists in the org", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([]); // assertMcpSlugAvailable — no conflict

      const drizzleError = Object.assign(
        new Error("DrizzleQueryError: Failed query"),
        {
          cause: {
            code: "23505",
            message:
              'duplicate key value violates unique constraint "unique_mcp_name_org"',
          },
        },
      );
      mockDb.returning.mockRejectedValueOnce(drizzleError);

      const res = await app.request(baseUrl, json("POST", createBody));

      // The conflict now flows through the central onError (ADR-0010).
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error: "A resource with that name already exists",
      });
    });
  });

  describe("GET /", () => {
    const list = async () => {
      const res = await app.request(baseUrl);
      const body = (await res.json()) as { results: Row[] };
      return { status: res.status, results: body.results };
    };

    it("lists only this organization's Shared MCPs", async () => {
      mockSession();
      world("member");

      const { status, results } = await list();

      expect(status).toBe(200);
      expect(results.map((r) => r.id)).toEqual(["mcp-1"]);
    });

    it("redacts request credentials and never returns OAuth tokens to a member", async () => {
      mockSession();
      world("member");

      const [row] = (await list()).results;

      expect(row).not.toHaveProperty("bearerToken");
      expect(row).not.toHaveProperty("headers");
      expect(row).not.toHaveProperty("oauthAccessToken");
      expect(row).not.toHaveProperty("oauthClientSecret");
      expect(row).toMatchObject({
        bearerTokenSet: { configured: true },
        headersSet: { configured: true },
      });
    });

    it("reveals request credentials, but not OAuth tokens, to an org admin", async () => {
      mockSession();
      world("admin");

      const [row] = (await list()).results;

      expect(row).toMatchObject({
        bearerToken: "bearer-secret",
        headers: { "X-Api-Key": "header-secret" },
      });
      expect(row).not.toHaveProperty("oauthAccessToken");
      expect(row).not.toHaveProperty("oauthClientSecret");
    });
  });

  describe("GET /:mcpId", () => {
    it("returns an org MCP, redacted for a member", async () => {
      mockSession();
      world("member");

      const res = await app.request(`${baseUrl}/mcp-1`);

      expect(res.status).toBe(200);
      const body = (await res.json()) as Row;
      expect(body).toMatchObject({ id: "mcp-1", name: "Org MCP" });
      expect(body).not.toHaveProperty("bearerToken");
    });

    it.each([
      ["another organization's Shared MCP", "mcp-other-org"],
      ["a Workspace-scoped MCP", "mcp-ws"],
    ])("returns 404 for %s", async (_label, id) => {
      mockSession();
      world("admin");

      const res = await app.request(`${baseUrl}/${id}`);
      expect(res.status).toBe(404);
    });
  });

  describe("PUT /:mcpId", () => {
    const updateBody = {
      name: "Renamed MCP",
      url: "http://mcp.com",
      authType: "None",
    };

    it("updates an org MCP if org admin", async () => {
      mockSession();
      mockDb.limit
        .mockResolvedValueOnce([{ role: "admin" }]) // requireOrgAccess
        .mockResolvedValueOnce([sharedMcp({ url: "http://mcp.com" })]) // requireOrgScoped
        .mockResolvedValueOnce([]); // assertMcpSlugAvailable — no conflict
      mockDb.returning.mockResolvedValueOnce([
        sharedMcp({ name: "Renamed MCP", url: "http://mcp.com" }),
      ]);

      const res = await app.request(
        `${baseUrl}/mcp-1`,
        json("PUT", updateBody),
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as Row;
      expect(body).toMatchObject({ id: "mcp-1", name: "Renamed MCP" });
      expect(body).not.toHaveProperty("oauthAccessToken");
    });

    it("returns 404 when the MCP is not a Shared MCP of this org", async () => {
      mockSession();
      mockDb.limit
        .mockResolvedValueOnce([{ role: "admin" }]) // requireOrgAccess
        .mockResolvedValueOnce([]); // requireOrgScoped: not found

      const res = await app.request(
        `${baseUrl}/mcp-other-org`,
        json("PUT", updateBody),
      );

      expect(res.status).toBe(404);
      expect(mockDb.update).not.toHaveBeenCalled();
    });

    it("returns 403 for a non-admin", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess

      const res = await app.request(
        `${baseUrl}/mcp-1`,
        json("PUT", updateBody),
      );

      expect(res.status).toBe(403);
      expect(mockDb.update).not.toHaveBeenCalled();
    });
  });

  describe("DELETE /:mcpId", () => {
    it("deletes an org MCP if org admin and not attached", async () => {
      mockSession();
      mockDb.limit
        .mockResolvedValueOnce([{ role: "admin" }]) // requireOrgAccess
        .mockResolvedValueOnce([]) // attachment guard: none
        .mockResolvedValueOnce([]); // blueprint guard: none
      mockDb.returning.mockResolvedValueOnce([{ id: "mcp-1" }]);

      const res = await app.request(`${baseUrl}/mcp-1`, { method: "DELETE" });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ message: "MCP deleted" });
    });

    it("returns 409 when the MCP is attached to a workspace", async () => {
      mockSession();
      mockDb.limit
        .mockResolvedValueOnce([{ role: "admin" }]) // requireOrgAccess
        .mockResolvedValueOnce([{ id: "att-1" }]); // attachment guard: attached

      const res = await app.request(`${baseUrl}/mcp-1`, { method: "DELETE" });
      expect(res.status).toBe(409);
      expect(mockDb.delete).not.toHaveBeenCalled();
    });

    it("returns 409 when the MCP is listed in a blueprint", async () => {
      mockSession();
      mockDb.limit
        .mockResolvedValueOnce([{ role: "admin" }]) // requireOrgAccess
        .mockResolvedValueOnce([]) // attachment guard: none
        .mockResolvedValueOnce([{ id: "bpi-1" }]); // blueprint guard: listed

      const res = await app.request(`${baseUrl}/mcp-1`, { method: "DELETE" });
      expect(res.status).toBe(409);
      expect(mockDb.delete).not.toHaveBeenCalled();
    });

    it("returns 403 for a non-admin", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess

      const res = await app.request(`${baseUrl}/mcp-1`, { method: "DELETE" });
      expect(res.status).toBe(403);
      expect(mockDb.delete).not.toHaveBeenCalled();
    });
  });

  describe("POST /test", () => {
    const probe = (body: unknown) =>
      app.request(`${baseUrl}/test`, json("POST", body));

    it("probes an unsaved MCP by URL", async () => {
      mockSession();
      world("admin");

      const res = await probe({ url: "http://mcp.com", authType: "None" });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        success: true,
        toolNames: ["tool1"],
        invalidToolNames: [],
      });
    });

    it("probes a stored OAuth MCP of this org", async () => {
      mockSession();
      world("admin");

      const res = await probe({
        url: "http://mcp.com",
        authType: "OAuth",
        mcpId: "mcp-1",
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ success: true });
    });

    it("returns a 404 result for another organization's OAuth MCP", async () => {
      mockSession();
      world("admin");

      const res = await probe({
        url: "http://mcp.com",
        authType: "OAuth",
        mcpId: "mcp-other-org",
      });

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({
        success: false,
        error: "MCP not found",
      });
    });

    it("returns 403 for a non-admin", async () => {
      mockSession();
      world("member");

      const res = await probe({ url: "http://mcp.com", authType: "None" });
      expect(res.status).toBe(403);
    });
  });

  describe("POST /:mcpId/oauth/authorize", () => {
    const authorize = (mcpId: string, query = "") =>
      app.request(`${baseUrl}/${mcpId}/oauth/authorize${query}`, {
        method: "POST",
      });

    it("force=true clears tokens and returns an authorizationUrl", async () => {
      mockSession();
      const fake = world("admin");

      vi.mocked(mcpAuth).mockImplementationOnce(
        (provider: { redirectToAuthorization: (url: URL) => void }) => {
          provider.redirectToAuthorization(
            new URL("https://provider.example.com/authorize?x=1"),
          );
          return Promise.resolve("REDIRECT");
        },
      );

      const res = await authorize("mcp-1", "?force=true");

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        authorizationUrl: "https://provider.example.com/authorize?x=1",
      });
      expect(tokensOf(fake, "mcp-1")).toEqual([null, null]);
      // The clear is scoped to this org's MCP alone.
      expect(tokensOf(fake, "mcp-other-org")).toEqual([
        "access-old",
        "refresh-old",
      ]);
    });

    it("returns 404 for another organization's MCP", async () => {
      mockSession();
      const fake = world("admin");

      const res = await authorize("mcp-other-org", "?force=true");

      expect(res.status).toBe(404);
      expect(tokensOf(fake, "mcp-other-org")).toEqual([
        "access-old",
        "refresh-old",
      ]);
      expect(mcpAuth).not.toHaveBeenCalled();
    });

    it("returns 403 for a non-admin", async () => {
      mockSession();
      world("member");

      const res = await authorize("mcp-1");
      expect(res.status).toBe(403);
      expect(mcpAuth).not.toHaveBeenCalled();
    });
  });

  describe("POST /:mcpId/oauth/revoke", () => {
    const revoke = (mcpId: string) =>
      app.request(`${baseUrl}/${mcpId}/oauth/revoke`, { method: "POST" });

    it("clears this org MCP's tokens only", async () => {
      mockSession();
      const fake = world("admin");

      const res = await revoke("mcp-1");

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true });
      expect(tokensOf(fake, "mcp-1")).toEqual([null, null]);
      expect(tokensOf(fake, "mcp-ws")).toEqual(["access-old", "refresh-old"]);
    });

    it.each([
      ["another organization's Shared MCP", "mcp-other-org"],
      ["a Workspace-scoped MCP", "mcp-ws"],
    ])("returns 404 for %s", async (_label, id) => {
      mockSession();
      const fake = world("admin");

      const res = await revoke(id);

      expect(res.status).toBe(404);
      expect(tokensOf(fake, id)).toEqual(["access-old", "refresh-old"]);
    });

    it("returns 403 for a non-admin", async () => {
      mockSession();
      const fake = world("member");

      const res = await revoke("mcp-1");

      expect(res.status).toBe(403);
      expect(tokensOf(fake, "mcp-1")).toEqual(["access-old", "refresh-old"]);
    });
  });
});
