import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockDb, resetMockDb } from "../test-utils.ts";

import { createAgentDiscoveryTools } from "./agent-discovery.ts";

const ctx = { toolCallId: "test", messages: [], context: {} };
const workspaceId = "ws-1";
const orgId = "org-1";
const frontendUrl = "http://localhost:3000";

/**
 * Stubs the two queries every scoped lookup runs: the workspace-scoped rows,
 * then the org-scoped (Shared) rows inner-joined to this workspace's
 * Attachments. A join result is keyed by table name, which is why the second
 * argument wraps each row.
 */
const stubScopedList = (
  resourceType: "agent" | "mcp" | "provider",
  workspaceRows: Record<string, unknown>[],
  attachedOrgRows: Record<string, unknown>[],
) => {
  mockDb.where.mockResolvedValueOnce(workspaceRows);
  mockDb.where.mockResolvedValueOnce(
    attachedOrgRows.map((row) => ({
      [resourceType]: row,
      attachment: { id: `att-${String(row.id)}` },
    })),
  );
};

describe("createAgentDiscoveryTools", () => {
  let tools: ReturnType<typeof createAgentDiscoveryTools>;

  beforeEach(() => {
    vi.clearAllMocks();
    resetMockDb();
    tools = createAgentDiscoveryTools(workspaceId, orgId, frontendUrl);
  });

  it("returns the expected tool names", () => {
    expect(Object.keys(tools)).toEqual([
      "listToolSets",
      "listModelProviders",
      "listAgents",
      "getAgent",
    ]);
  });

  describe("listModelProviders", () => {
    it("returns workspace providers and attached shared providers", async () => {
      stubScopedList(
        "provider",
        [{ id: "p1", name: "Provider 1", modelIds: ["model-a", "model-b"] }],
        [{ id: "p-org", name: "Shared Provider", modelIds: ["model-c"] }],
      );

      expect(await tools.listModelProviders.execute!({}, ctx)).toEqual([
        { id: "p1", name: "Provider 1", modelIds: ["model-a", "model-b"] },
        { id: "p-org", name: "Shared Provider", modelIds: ["model-c"] },
      ]);
    });

    it("omits a shared provider that is not attached to this workspace", async () => {
      // An unattached Shared Provider cannot resolve at Chat-turn time, so
      // offering it would only produce an Agent that cannot run.
      stubScopedList(
        "provider",
        [{ id: "p1", name: "Provider 1", modelIds: ["model-a"] }],
        [],
      );

      expect(await tools.listModelProviders.execute!({}, ctx)).toEqual([
        { id: "p1", name: "Provider 1", modelIds: ["model-a"] },
      ]);
      // The org-scoped half is gated by a join on the Attachment table. Without
      // it the whole organization's providers would be listed, attached or not.
      expect(mockDb.innerJoin).toHaveBeenCalledTimes(1);
    });

    it("flattens per-model object modelIds to plain id strings", async () => {
      stubScopedList(
        "provider",
        [
          {
            id: "p1",
            name: "Provider 1",
            modelIds: [
              { id: "model-a", passthroughFileTypes: ["image/*"] },
              { id: "model-b", passthroughFileTypes: [] },
            ],
          },
        ],
        [],
      );

      expect(await tools.listModelProviders.execute!({}, ctx)).toEqual([
        { id: "p1", name: "Provider 1", modelIds: ["model-a", "model-b"] },
      ]);
    });

    it("advertises an aliased model by its alias reference, not its id", async () => {
      // The tool is the agentic counterpart of the Agent model picker, so it
      // offers what the picker submits — otherwise an agent it creates pins the
      // concrete id and misses the next repoint (#386, ADR-0017).
      stubScopedList(
        "provider",
        [
          {
            id: "p1",
            name: "Provider 1",
            modelIds: [
              {
                id: "gpt-4",
                passthroughFileTypes: ["image/*"],
                alias: "flagship",
              },
              { id: "gpt-4o-mini", passthroughFileTypes: [] },
            ],
          },
        ],
        [],
      );

      expect(await tools.listModelProviders.execute!({}, ctx)).toEqual([
        {
          id: "p1",
          name: "Provider 1",
          modelIds: ["alias:flagship", "gpt-4o-mini"],
        },
      ]);
    });
  });

  describe("listToolSets", () => {
    it("includes attached shared MCPs alongside the registered tool sets", async () => {
      stubScopedList(
        "mcp",
        [{ id: "mcp-ws", name: "Workspace MCP" }],
        [{ id: "mcp-org", name: "Shared MCP" }],
      );

      const result = (await tools.listToolSets.execute!({}, ctx)) as Array<{
        id: string;
        name: string;
        category: string;
      }>;

      expect(result).toEqual(
        expect.arrayContaining([
          { id: "mcp-ws", name: "Workspace MCP", category: "MCP" },
          { id: "mcp-org", name: "Shared MCP", category: "MCP" },
        ]),
      );
      // The statically registered sets are still listed.
      expect(result.some((entry) => entry.category !== "MCP")).toBe(true);
    });
  });

  describe("listAgents", () => {
    it("returns workspace agents and attached shared agents, each tagged with its scope", async () => {
      stubScopedList(
        "agent",
        [
          {
            id: "a1",
            name: "Agent 1",
            description: "Local",
            modelId: "m1",
            providerId: "p1",
          },
        ],
        [
          {
            id: "a-org",
            name: "Shared Agent",
            description: "Shared",
            modelId: "m1",
            providerId: "p-org",
          },
        ],
      );

      expect(await tools.listAgents.execute!({}, ctx)).toEqual([
        {
          id: "a1",
          name: "Agent 1",
          description: "Local",
          modelId: "m1",
          providerId: "p1",
          scope: "workspace",
        },
        {
          id: "a-org",
          name: "Shared Agent",
          description: "Shared",
          modelId: "m1",
          providerId: "p-org",
          scope: "organization",
        },
      ]);
    });
  });

  describe("getAgent", () => {
    it("returns error when agent not found", async () => {
      mockDb.limit.mockResolvedValue([]);

      expect(
        await tools.getAgent.execute!(
          { agentId: "bad-id", label: "test" },
          ctx,
        ),
      ).toEqual({ error: "Agent not found" });
    });

    it("returns error for a shared agent that is not attached to this workspace", async () => {
      // The row exists at org scope; the attachment lookup finds nothing.
      mockDb.limit.mockResolvedValueOnce([
        { id: "a-org", name: "Shared Agent", organizationId: orgId },
      ]);
      mockDb.limit.mockResolvedValueOnce([]);

      expect(
        await tools.getAgent.execute!(
          { agentId: "a-org", label: "Shared Agent" },
          ctx,
        ),
      ).toEqual({ error: "Agent not found" });
    });

    it("returns agent details when found, tagged with its scope", async () => {
      mockDb.limit.mockResolvedValue([
        {
          id: "a1",
          name: "Agent 1",
          workspaceId,
          modelId: "m1",
          providerId: "p1",
          avatarKey: "agents/a1.png",
        },
      ]);

      const result = (await tools.getAgent.execute!(
        { agentId: "a1", label: "Agent 1" },
        ctx,
      )) as { id: string; name: string; scope: string; url?: string };

      expect(result).toMatchObject({
        id: "a1",
        name: "Agent 1",
        scope: "workspace",
      });
      expect(result.url).toContain("agents/a1");
      // The avatar key is not a field the model has any use for.
      expect(result).not.toHaveProperty("avatarKey");
    });
  });
});
