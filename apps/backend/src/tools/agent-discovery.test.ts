import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockDb, resetMockDb } from "../test-utils.ts";

import { createAgentDiscoveryTools } from "./agent-discovery.ts";

const ctx = { toolCallId: "test", messages: [] };
const workspaceId = "ws-1";
const orgId = "org-1";
const frontendUrl = "http://localhost:3000";

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
    it("returns providers for workspace and org", async () => {
      const providers = [
        { id: "p1", name: "Provider 1", modelIds: ["model-a", "model-b"] },
        { id: "p2", name: "Provider 2", modelIds: ["model-c"] },
      ];
      mockDb.where.mockResolvedValue(providers);

      expect(await tools.listModelProviders.execute!({}, ctx)).toEqual(
        providers,
      );
    });
  });

  describe("listAgents", () => {
    it("returns agents in workspace", async () => {
      const agents = [{ id: "a1", name: "Agent 1" }];
      mockDb.where.mockResolvedValue(agents);

      expect(await tools.listAgents.execute!({}, ctx)).toEqual(agents);
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

    it("returns agent details when found", async () => {
      const agent = {
        id: "a1",
        name: "Agent 1",
        workspaceId,
        modelId: "m1",
        providerId: "p1",
      };
      mockDb.limit.mockResolvedValue([agent]);

      const result = (await tools.getAgent.execute!(
        { agentId: "a1", label: "Agent 1" },
        ctx,
      )) as { id: string; name: string; url?: string };

      expect(result).toMatchObject({ id: "a1", name: "Agent 1" });
      expect(result.url).toContain("agents/a1");
    });
  });
});
