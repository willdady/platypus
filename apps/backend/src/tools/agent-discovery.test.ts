import { describe, it, expect, beforeEach } from "vitest";
import { callTool, resetMockDb, seedDb } from "../test-utils.ts";

import { createAgentDiscoveryTools } from "./agent-discovery.ts";
import { registerToolSet } from "./index.ts";

const workspaceId = "ws-1";
const orgId = "org-1";
const frontendUrl = "http://localhost:3000";

type Scope = { workspaceId?: string; organizationId?: string };
const mine: Scope = { workspaceId };
const org: Scope = { organizationId: orgId };

const row = (id: string, scope: Scope, over: Record<string, unknown> = {}) => ({
  id,
  name: id,
  workspaceId: scope.workspaceId ?? null,
  organizationId: scope.organizationId ?? null,
  ...over,
});

const attached = (
  resourceType: string,
  resourceId: string,
  ws = workspaceId,
) => ({
  id: `att-${resourceId}-${ws}`,
  workspaceId: ws,
  resourceType,
  resourceId,
});

/**
 * One visible row of `type` per scope (this workspace's own, and a Shared one
 * attached here), plus the rows that must never reach this workspace: another
 * workspace's, a Shared one attached only elsewhere, and another org's.
 */
const seedScoped = (
  type: "agent" | "mcp" | "provider",
  fields: (id: string) => Record<string, unknown> = () => ({}),
) => {
  const seeded = (id: string, scope: Scope) => row(id, scope, fields(id));
  return {
    [type]: [
      seeded(`${type}-mine`, mine),
      seeded(`${type}-shared`, org),
      seeded(`${type}-elsewhere`, { workspaceId: "ws-2" }),
      seeded(`${type}-unattached`, org),
      seeded(`${type}-other-org`, { organizationId: "org-2" }),
    ],
    attachment: [
      attached(type, `${type}-shared`),
      attached(type, `${type}-unattached`, "ws-2"),
      attached(type, `${type}-other-org`),
    ],
  };
};

describe("createAgentDiscoveryTools", () => {
  let tools: ReturnType<typeof createAgentDiscoveryTools>;

  beforeEach(() => {
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
    it("lists only this workspace's providers and the Shared ones attached here", async () => {
      // An unattached Shared Provider cannot resolve at Chat-turn time, so
      // offering it would only produce an Agent that cannot run.
      seedDb(seedScoped("provider", () => ({ modelIds: ["model-a"] })));

      expect(await callTool(tools.listModelProviders, {})).toEqual([
        { id: "provider-mine", name: "provider-mine", modelIds: ["model-a"] },
        {
          id: "provider-shared",
          name: "provider-shared",
          modelIds: ["model-a"],
        },
      ]);
    });

    it("advertises per-model objects by id, and an aliased model by its alias reference", async () => {
      // The tool is the agentic counterpart of the Agent model picker, so it
      // offers what the picker submits — otherwise an agent it creates pins the
      // concrete id and misses the next repoint (#386, ADR-0017).
      seedDb({
        provider: [
          row("p1", mine, {
            modelIds: [
              {
                id: "gpt-4",
                passthroughFileTypes: ["image/*"],
                alias: "flagship",
              },
              { id: "gpt-4o-mini", passthroughFileTypes: [] },
            ],
          }),
        ],
      });

      expect(await callTool(tools.listModelProviders, {})).toEqual([
        { id: "p1", name: "p1", modelIds: ["alias:flagship", "gpt-4o-mini"] },
      ]);
    });
  });

  it("listToolSets lists the registered tool sets and this workspace's visible MCPs", async () => {
    registerToolSet("test-set", {
      name: "Test set",
      category: "Testing",
      description: "A registered set",
      buildTurnTools: () => Promise.resolve({}),
    });
    seedDb(seedScoped("mcp"));

    const result = (await callTool(tools.listToolSets, {})) as {
      category: string;
    }[];

    expect(result).toContainEqual({
      id: "test-set",
      name: "Test set",
      category: "Testing",
      description: "A registered set",
    });
    expect(result.filter((entry) => entry.category === "MCP")).toEqual([
      { id: "mcp-mine", name: "mcp-mine", category: "MCP" },
      { id: "mcp-shared", name: "mcp-shared", category: "MCP" },
    ]);
  });

  it("listAgents lists this workspace's agents and attached Shared ones, tagged with scope", async () => {
    seedDb(
      seedScoped("agent", (id) => ({
        description: `${id} description`,
        modelId: "m1",
        providerId: "p1",
      })),
    );

    expect(await callTool(tools.listAgents, {})).toEqual([
      {
        id: "agent-mine",
        name: "agent-mine",
        description: "agent-mine description",
        modelId: "m1",
        providerId: "p1",
        scope: "workspace",
      },
      {
        id: "agent-shared",
        name: "agent-shared",
        description: "agent-shared description",
        modelId: "m1",
        providerId: "p1",
        scope: "organization",
      },
    ]);
  });

  describe("getAgent", () => {
    beforeEach(() => {
      seedDb(seedScoped("agent", () => ({ avatarKey: "agents/a.png" })));
    });

    it("returns every field but the avatar key, tagged with scope, with a link", async () => {
      expect(
        await callTool(tools.getAgent, { agentId: "agent-mine", label: "A" }),
      ).toEqual({
        ...row("agent-mine", mine),
        scope: "workspace",
        url: "http://localhost:3000/org-1/workspace/ws-1/agents/agent-mine",
      });
    });

    it("returns an attached Shared agent", async () => {
      expect(
        await callTool(tools.getAgent, { agentId: "agent-shared", label: "A" }),
      ).toMatchObject({ id: "agent-shared", scope: "organization" });
    });

    it.each([
      "agent-elsewhere",
      "agent-unattached",
      "agent-other-org",
      "missing",
    ])("does not find %s", async (agentId) => {
      expect(await callTool(tools.getAgent, { agentId, label: "A" })).toEqual({
        error: "Agent not found",
      });
    });
  });
});
