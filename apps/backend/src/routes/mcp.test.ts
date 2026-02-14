import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockDb, mockSession, resetMockDb } from "../test-utils.ts";
import app from "../server.ts";

vi.mock("@ai-sdk/mcp", () => ({
  experimental_createMCPClient: vi.fn().mockResolvedValue({
    tools: vi.fn().mockResolvedValue({ tool1: {} }),
    close: vi.fn().mockResolvedValue(undefined),
  }),
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
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
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
  });

  describe("GET /", () => {
    it("should list MCPs", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]); // requireWorkspaceAccess

      const mockMcps = [{ id: "mcp-1", name: "MCP 1" }];
      mockDb.where
        .mockReturnValueOnce(mockDb)
        .mockReturnValueOnce(mockDb)
        .mockResolvedValueOnce(mockMcps);

      const res = await app.request(baseUrl);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ results: mockMcps });
    });
  });

  describe("POST /test", () => {
    it("should test MCP connection", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
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
});
