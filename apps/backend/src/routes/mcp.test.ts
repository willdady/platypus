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

describe("MCP Routes", () => {
  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
    mockDb.where.mockReturnValue(mockDb);
  });

  const orgId = "org-1";
  const workspaceId = "ws-1";
  const baseUrl = `/organizations/${orgId}/workspaces/${workspaceId}/mcps`;

  describe("POST /", () => {
    it("should create MCP if workspace admin", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]); // requireWorkspaceAccess

      const mockMcp = { id: "mcp-1", name: "New MCP", url: "http://mcp.com" };
      mockDb.returning.mockResolvedValueOnce([mockMcp]);

      const res = await app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify({
          name: "New MCP",
          url: "http://mcp.com",
          authType: "None",
          workspaceId,
        }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(201);
      expect(await res.json()).toEqual(mockMcp);
    });

    // ADR-0006: MCP config is admin-only unless the workspace's
    // mcpSelfManagement flag delegates it to the owner.
    const createBody = {
      name: "New MCP",
      url: "http://mcp.com",
      authType: "None",
      workspaceId,
    };

    it("returns 403 for a non-admin owner when self-management is disabled", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]); // requireWorkspaceAccess
      mockDb.limit.mockResolvedValueOnce([{ flag: false }]); // delegation flag

      const res = await app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify(createBody),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(403);
    });

    it("allows a non-admin owner when self-management is enabled", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]);
      mockDb.limit.mockResolvedValueOnce([{ flag: true }]); // delegation flag set
      mockDb.returning.mockResolvedValueOnce([
        { id: "mcp-1", name: "New MCP" },
      ]);

      const res = await app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify(createBody),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(201);
    });
  });

  describe("GET /", () => {
    it("should list workspace-scoped and org-scoped MCPs tagged with scope", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]); // requireWorkspaceAccess

      const workspaceMcps = [
        { id: "mcp-ws", name: "Workspace MCP", authType: "None" },
      ];
      const orgMcps = [{ id: "mcp-org", name: "Org MCP", authType: "None" }];
      mockDb.where
        .mockReturnValueOnce(mockDb) // requireOrgAccess
        .mockReturnValueOnce(mockDb) // requireWorkspaceAccess
        .mockResolvedValueOnce(workspaceMcps) // route: workspace-scoped query
        .mockResolvedValueOnce(orgMcps); // route: org-scoped query

      const res = await app.request(baseUrl);
      expect(res.status).toBe(200);
      const body = await res.json();
      // Org-scoped MCPs are listed first, then workspace-scoped, each tagged.
      expect(body.results).toEqual([
        expect.objectContaining({ id: "mcp-org", scope: "organization" }),
        expect.objectContaining({ id: "mcp-ws", scope: "workspace" }),
      ]);
    });
  });

  describe("POST /test", () => {
    it("should test MCP connection", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]); // requireWorkspaceAccess

      const res = await app.request(`${baseUrl}/test`, {
        method: "POST",
        body: JSON.stringify({
          url: "http://mcp.com",
          authType: "None",
        }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true, toolNames: ["tool1"] });
    });
  });

  describe("POST /:mcpId/oauth/authorize", () => {
    const mcpId = "mcp-1";
    const authorizeUrl = `${baseUrl}/${mcpId}/oauth/authorize`;

    const mcpRecord = {
      id: mcpId,
      workspaceId,
      authType: "OAuth",
      url: "http://mcp.example.com",
      oauthAccessToken: "access-old",
      oauthRefreshToken: "refresh-old",
      oauthTokenExpiresAt: new Date(),
      oauthScope: "read",
      oauthClientId: "client-id",
      oauthClientSecret: "client-secret",
    };

    it("force=true: clears the four oauth token columns in DB and returns authorizationUrl", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]); // requireWorkspaceAccess
      mockDb.limit.mockResolvedValueOnce([{ ...mcpRecord }]); // MCP lookup

      (mcpAuth as any).mockImplementationOnce(async (provider: any) => {
        await provider.redirectToAuthorization(
          new URL("https://provider.example.com/authorize?x=1"),
        );
        return "REDIRECT";
      });

      const res = await app.request(`${authorizeUrl}?force=true`, {
        method: "POST",
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        authorizationUrl: "https://provider.example.com/authorize?x=1",
      });

      // Token-clear update was issued
      expect(mockDb.update).toHaveBeenCalled();
      expect(mockDb.set).toHaveBeenCalledWith(
        expect.objectContaining({
          oauthAccessToken: null,
          oauthRefreshToken: null,
          oauthTokenExpiresAt: null,
          oauthScope: null,
        }),
      );

      // DCR/static client credentials are deliberately preserved
      const setPayload = (mockDb.set as any).mock.calls[0][0];
      expect(setPayload).not.toHaveProperty("oauthClientId");
      expect(setPayload).not.toHaveProperty("oauthClientSecret");
    });

    it("no force flag: leaves token columns untouched when SDK silently refreshes", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]); // requireWorkspaceAccess
      mockDb.limit.mockResolvedValueOnce([{ ...mcpRecord }]); // MCP lookup

      (mcpAuth as any).mockResolvedValueOnce("AUTHORIZED");

      const res = await app.request(authorizeUrl, { method: "POST" });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ alreadyAuthorized: true });

      // No update issued → token columns untouched
      expect(mockDb.update).not.toHaveBeenCalled();
    });
  });
});
