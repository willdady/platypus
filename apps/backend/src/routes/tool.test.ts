import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  loadedPluginsFixture,
  mockDb,
  mockSession,
  resetMockDb,
} from "../test-utils.ts";
import app from "../server.ts";
import { setLoadedPlugins } from "../plugins/registry.ts";

vi.mock("../tools/index.ts", () => ({
  getToolSets: vi.fn().mockReturnValue([
    {
      id: "math",
      name: "Math",
      category: "Utilities",
      description: "Math tools",
      staticTools: {
        add: { description: "Add numbers" },
      },
      buildTurnTools: vi.fn(),
    },
    {
      id: "sandbox",
      name: "Sandbox",
      category: "Sandbox",
      description: "Sandbox tools",
      buildTurnTools: vi.fn(),
    },
  ]),
}));

describe("Tool Routes", () => {
  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
    mockDb.where.mockReturnValue(mockDb);
    setLoadedPlugins(
      loadedPluginsFixture(
        [
          {
            name: "@platypus/tools-basic",
            version: "1.0.0",
            origin: "core",
            toolSetIds: ["math"],
            sandboxBackendIds: [],
            webBackendIds: [],
            toolGateIds: [],
            config: undefined,
          },
        ],
        { toolSets: new Map([["math", "@platypus/tools-basic"]]) },
      ),
    );
  });

  const orgId = "org-1";
  const workspaceId = "ws-1";
  const baseUrl = `/organizations/${orgId}/workspaces/${workspaceId}/tools`;

  describe("GET /", () => {
    it("should list all tool sets including MCPs", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]);

      mockDb.where
        .mockReturnValueOnce(mockDb)
        .mockReturnValueOnce(mockDb)
        .mockResolvedValueOnce([{ id: "mcp-1", name: "MCP 1" }])
        .mockResolvedValueOnce([]);

      const res = await app.request(baseUrl);
      expect(res.status).toBe(200);
      const json = (await res.json()) as Record<string, unknown>;

      expect(json.results).toContainEqual(
        expect.objectContaining({
          id: "math",
          name: "Math",
          category: "Utilities",
          plugin: "@platypus/tools-basic",
          tools: [{ id: "add", description: "Add numbers" }],
        }),
      );

      expect(json.results).toContainEqual(
        expect.objectContaining({
          id: "sandbox",
          name: "Sandbox",
          plugin: "core (built-in)",
          tools: [],
        }),
      );

      expect(json.results).toContainEqual(
        expect.objectContaining({
          id: "mcp-1",
          name: "MCP 1",
          category: "MCP",
        }),
      );
    });

    it("includes Shared MCPs attached to this workspace", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]);

      mockDb.where
        .mockReturnValueOnce(mockDb)
        .mockReturnValueOnce(mockDb)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          { mcp: { id: "mcp-shared", name: "Shared MCP" } },
        ]);

      const res = await app.request(baseUrl);
      expect(res.status).toBe(200);
      const json = (await res.json()) as Record<string, unknown>;

      expect(json.results).toContainEqual(
        expect.objectContaining({
          id: "mcp-shared",
          name: "Shared MCP",
          category: "MCP",
        }),
      );
    });
  });
});
