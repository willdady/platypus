import { tool, type Tool } from "ai";
import { z } from "zod";
import { db } from "../index.ts";
import { getToolSets, shareTool } from "../tools/index.ts";
import { buildResourceUrl } from "../utils/resource-url.ts";
import { providerModelReferences } from "../services/model-capability.ts";
import { listScoped, resolveScoped } from "../services/scoped-resource.ts";
import type { ScopeContext } from "../scope.ts";

export function createListAgentsTool(ctx: ScopeContext): Tool {
  return shareTool(
    "listAgents",
    tool({
      description:
        "List the agents available in the current workspace, including shared agents attached to it.",
      inputSchema: z.object({}),
      execute: async () => {
        const scoped = await listScoped(db, "agent", ctx);
        return scoped.map(({ row, scope }) => ({
          id: row.id,
          name: row.name,
          description: row.description,
          modelId: row.modelId,
          providerId: row.providerId,
          scope,
        }));
      },
    }),
  );
}

export function createAgentDiscoveryTools(
  workspaceId: string,
  orgId: string,
  frontendUrl: string,
): Record<string, Tool> {
  const ctx: ScopeContext = { orgId, workspaceId };

  const listToolSets = tool({
    description:
      "List all available tool sets and MCP servers. Use the returned IDs when assigning toolSetIds to agents.",
    inputSchema: z.object({}),
    execute: async () => {
      const toolSetsList = getToolSets().map((toolSet) => ({
        id: toolSet.id,
        name: toolSet.name,
        category: toolSet.category,
        description: toolSet.description,
      }));

      const mcps = await listScoped(db, "mcp", ctx);
      const mcpList = mcps.map(({ row }) => ({
        id: row.id,
        name: row.name,
        category: "MCP",
      }));

      return [...toolSetsList, ...mcpList];
    },
  });

  const listModelProviders = tool({
    description:
      "List all configured providers and their available model IDs. Use the returned provider IDs and model IDs when creating or updating agents, and pass a model ID back exactly as returned. An entry of the form 'alias:<name>' is a Model alias the provider gave one of its models: submit it unchanged rather than the vendor model id it currently points at, so the agent follows the alias when an admin repoints it.",
    inputSchema: z.object({}),
    execute: async () => {
      const providers = await listScoped(db, "provider", ctx);
      return providers.map(({ row }) => ({
        id: row.id,
        name: row.name,
        modelIds: providerModelReferences(row),
      }));
    },
  });

  const listAgents = createListAgentsTool(ctx);

  const getAgent = tool({
    description: "Get full agent details by ID (excludes avatar).",
    inputSchema: z.object({
      agentId: z.string().describe("The ID of the agent to retrieve"),
      label: z.string().describe("The agent name (for display purposes)"),
    }),
    execute: async ({ agentId }) => {
      const found = await resolveScoped(db, "agent", agentId, ctx);
      if (!found) {
        return { error: "Agent not found" };
      }

      const { avatarKey: _avatarKey, ...rest } = found.row;
      const url = buildResourceUrl(
        frontendUrl,
        orgId,
        workspaceId,
        `agents/${agentId}`,
      );

      return { ...rest, scope: found.scope, url };
    },
  });

  return {
    listToolSets,
    listModelProviders,
    listAgents,
    getAgent,
  };
}
