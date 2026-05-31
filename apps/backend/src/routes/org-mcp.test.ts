import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockDb, mockSession, resetMockDb } from "../test-utils.ts";
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

  const createBody = {
    name: "Org MCP",
    url: "http://mcp.com",
    authType: "None",
    organizationId: orgId,
  };

  describe("POST /", () => {
    it("creates an org MCP if org admin", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]); // requireOrgAccess

      const mockMcp = {
        id: "mcp-1",
        name: "Org MCP",
        organizationId: orgId,
        authType: "None",
      };
      mockDb.returning.mockResolvedValueOnce([mockMcp]);

      const res = await app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify(createBody),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(201);
      expect(await res.json()).toEqual(mockMcp);
    });

    it("returns 403 if not org admin", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess

      const res = await app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify(createBody),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(403);
    });

    it("returns 409 if an MCP name already exists in the org", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]); // requireOrgAccess

      const drizzleError = new Error("DrizzleQueryError: Failed query");
      (drizzleError as any).cause = {
        code: "23505",
        message:
          'duplicate key value violates unique constraint "unique_mcp_name_org"',
      };
      mockDb.returning.mockRejectedValueOnce(drizzleError);

      const res = await app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify(createBody),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error: "An MCP with this name already exists in this organization",
      });
    });
  });

  describe("GET /", () => {
    it("lists org MCPs", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess

      const mockMcps = [{ id: "mcp-1", name: "Org MCP", authType: "None" }];
      mockDb.where
        .mockReturnValueOnce(mockDb) // requireOrgAccess
        .mockResolvedValueOnce(mockMcps); // route

      const res = await app.request(baseUrl);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.results).toEqual([
        expect.objectContaining({ id: "mcp-1", name: "Org MCP" }),
      ]);
    });
  });

  describe("GET /:mcpId", () => {
    it("returns an org MCP", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess

      const mockMcp = { id: "mcp-1", name: "Org MCP", authType: "None" };
      mockDb.where
        .mockReturnValueOnce(mockDb) // requireOrgAccess
        .mockReturnValueOnce(mockDb); // route
      mockDb.limit.mockResolvedValueOnce([mockMcp]); // route

      const res = await app.request(`${baseUrl}/mcp-1`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(
        expect.objectContaining({ id: "mcp-1", name: "Org MCP" }),
      );
    });
  });

  describe("DELETE /:mcpId", () => {
    it("deletes an org MCP if org admin", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]); // requireOrgAccess
      mockDb.returning.mockResolvedValueOnce([{ id: "mcp-1" }]);

      const res = await app.request(`${baseUrl}/mcp-1`, { method: "DELETE" });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ message: "MCP deleted" });
    });

    it("returns 403 for a non-admin", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess

      const res = await app.request(`${baseUrl}/mcp-1`, { method: "DELETE" });
      expect(res.status).toBe(403);
    });
  });

  describe("POST /:mcpId/oauth/authorize", () => {
    const mcpId = "mcp-1";
    const mcpRecord = {
      id: mcpId,
      organizationId: orgId,
      workspaceId: null,
      authType: "OAuth",
      url: "http://mcp.example.com",
      oauthAccessToken: "access-old",
      oauthRefreshToken: "refresh-old",
      oauthTokenExpiresAt: new Date(),
      oauthScope: "read",
      oauthClientId: "client-id",
      oauthClientSecret: "client-secret",
    };

    it("force=true clears tokens and returns an authorizationUrl", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ ...mcpRecord }]); // MCP lookup

      (mcpAuth as any).mockImplementationOnce(async (provider: any) => {
        await provider.redirectToAuthorization(
          new URL("https://provider.example.com/authorize?x=1"),
        );
        return "REDIRECT";
      });

      const res = await app.request(
        `${baseUrl}/${mcpId}/oauth/authorize?force=true`,
        { method: "POST" },
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        authorizationUrl: "https://provider.example.com/authorize?x=1",
      });
      expect(mockDb.set).toHaveBeenCalledWith(
        expect.objectContaining({
          oauthAccessToken: null,
          oauthRefreshToken: null,
        }),
      );
    });

    it("returns 403 for a non-admin", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess

      const res = await app.request(`${baseUrl}/${mcpId}/oauth/authorize`, {
        method: "POST",
      });
      expect(res.status).toBe(403);
    });
  });
});
