import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockDb, mockSession, resetMockDb } from "../test-utils.ts";
import app from "../server.ts";

vi.mock("../tools/index.ts", () => ({
  getToolSets: vi.fn().mockReturnValue({
    "math": {
      name: "Math",
      category: "Utilities",
      description: "Math tools",
      tools: {
        "add": { description: "Add numbers" }
      }
    }
  }),
}));

describe("Tool Routes", () => {
  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
    mockDb.where.mockReturnValue(mockDb);
  });

  const orgId = "org-1";
  const workspaceId = "ws-1";
  const baseUrl = `/organisations/${orgId}/workspaces/${workspaceId}/tools`;

  describe("GET /", () => {
    it("should list all tool sets including MCPs", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ role: "viewer" }]); // requireWorkspaceAccess
      
      const mockMcps = [{ id: "mcp-1", name: "MCP 1" }];
      mockDb.where
        .mockReturnValueOnce(mockDb)
        .mockReturnValueOnce(mockDb)
        .mockResolvedValueOnce(mockMcps);

      const res = await app.request(baseUrl);
      expect(res.status).toBe(200);
      const json = await res.json();
      
      // Static tools
      expect(json.results).toContainEqual(expect.objectContaining({
        id: "math",
        name: "Math",
        category: "Utilities"
      }));
      
      // MCPs
      expect(json.results).toContainEqual(expect.objectContaining({
        id: "mcp-1",
        name: "MCP 1",
        category: "MCP"
      }));
    });
  });
});
