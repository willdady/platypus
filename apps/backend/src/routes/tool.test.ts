import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  loadedPluginsFixture,
  mockSession,
  resetMockDb,
  seedDb,
  type FakeDb,
  type Row,
  type Store,
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

  const workspaceMcp = (over: Row = {}): Row => ({
    id: "mcp-1",
    name: "MCP 1",
    organizationId: null,
    workspaceId,
    ...over,
  });

  const sharedMcp = (over: Row = {}): Row =>
    workspaceMcp({
      id: "mcp-shared",
      name: "Shared MCP",
      organizationId: orgId,
      workspaceId: null,
      ...over,
    });

  const attachedHere = (resourceId: string): Row => ({
    id: `att-${resourceId}`,
    workspaceId,
    resourceType: "mcp",
    resourceId,
  });

  const world = (rows: Store = {}): FakeDb =>
    seedDb({
      organization_member: [
        {
          id: "m1",
          userId: "user-1",
          organizationId: orgId,
          role: "member",
        },
      ],
      workspace: [
        { id: workspaceId, organizationId: orgId, ownerId: "user-1" },
      ],
      ...rows,
    });

  describe("GET /", () => {
    it("should list all tool sets including MCPs", async () => {
      mockSession();
      world({
        mcp: [
          workspaceMcp(),
          workspaceMcp({
            id: "mcp-elsewhere",
            name: "Elsewhere",
            workspaceId: "ws-2",
          }),
        ],
      });

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

      expect(json.results).not.toContainEqual(
        expect.objectContaining({ id: "mcp-elsewhere" }),
      );
    });

    it("includes Shared MCPs attached to this workspace", async () => {
      mockSession();
      world({
        mcp: [
          sharedMcp(),
          sharedMcp({ id: "mcp-unattached", name: "Unattached" }),
          sharedMcp({
            id: "mcp-other-org",
            name: "Foreign",
            organizationId: "org-2",
          }),
        ],
        attachment: [attachedHere("mcp-shared"), attachedHere("mcp-other-org")],
      });

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
      expect(json.results).not.toContainEqual(
        expect.objectContaining({ id: "mcp-unattached" }),
      );
      expect(json.results).not.toContainEqual(
        expect.objectContaining({ id: "mcp-other-org" }),
      );
    });
  });
});
