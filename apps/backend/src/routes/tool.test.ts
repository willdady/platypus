import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockDb, mockSession, resetMockDb } from "../test-utils.ts";
import app from "../server.ts";
import { setLoadedPlugins } from "../plugins/registry.ts";

vi.mock("../tools/index.ts", () => ({
  getToolSets: vi.fn().mockReturnValue({
    math: {
      name: "Math",
      category: "Utilities",
      description: "Math tools",
      tools: {
        add: { description: "Add numbers" },
      },
    },
    // A core-internal static set (e.g. `sandbox`) with no owning plugin: it
    // must annotate as `plugin: null`, not crash.
    sandbox: {
      name: "Sandbox",
      category: "Sandbox",
      description: "Sandbox tools",
      tools: () => ({}),
    },
  }),
}));

describe("Tool Routes", () => {
  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
    mockDb.where.mockReturnValue(mockDb);
    // Seed the plugin registry so the Tools listing can annotate the `math`
    // set with its originating plugin (ADR-0013). `sandbox` is intentionally
    // absent — it is a static registration, not a plugin contribution.
    setLoadedPlugins([
      {
        name: "@platypus/tools-basic",
        version: "1.0.0",
        origin: "core",
        toolSetIds: ["math"],
        sandboxBackendIds: [],
      },
    ]);
  });

  const orgId = "org-1";
  const workspaceId = "ws-1";
  const baseUrl = `/organizations/${orgId}/workspaces/${workspaceId}/tools`;

  describe("GET /", () => {
    it("should list all tool sets including MCPs", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]); // requireWorkspaceAccess

      const mockMcps = [{ id: "mcp-1", name: "MCP 1" }];
      mockDb.where
        .mockReturnValueOnce(mockDb)
        .mockReturnValueOnce(mockDb)
        .mockResolvedValueOnce(mockMcps);

      const res = await app.request(baseUrl);
      expect(res.status).toBe(200);
      const json = (await res.json()) as Record<string, unknown>;

      // Static tools, annotated with the contributing plugin (ADR-0013).
      expect(json.results).toContainEqual(
        expect.objectContaining({
          id: "math",
          name: "Math",
          category: "Utilities",
          plugin: "@platypus/tools-basic",
        }),
      );

      // A set with no owning plugin annotates as null, not undefined/omitted.
      expect(json.results).toContainEqual(
        expect.objectContaining({
          id: "sandbox",
          name: "Sandbox",
          plugin: null,
        }),
      );

      // MCPs
      expect(json.results).toContainEqual(
        expect.objectContaining({
          id: "mcp-1",
          name: "MCP 1",
          category: "MCP",
        }),
      );
    });
  });
});
