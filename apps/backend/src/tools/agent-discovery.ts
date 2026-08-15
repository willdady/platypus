import { tool, type Tool } from "ai";
import { z } from "zod";
import { db } from "../index.ts";
import { getToolSets } from "../tools/index.ts";
import { buildResourceUrl } from "../utils/resource-url.ts";
import { providerModelReferences } from "../services/model-capability.ts";
import { listScoped, resolveScoped } from "../services/scoped-resource.ts";
import type { ScopeContext } from "../scope.ts";
import type { Provider } from "@platypus/schemas";

/**
 * Every lookup in this module resolves at the invoking Workspace's scope:
 * Workspace-scoped rows, plus the Organization-scoped (Shared) rows attached to
 * it (ADR-0007). That is the same set the Workspace's own list routes return, so
 * an Operator working through an Agent sees exactly what they would see in the
 * UI — no Shared resource it could name but not use, and none it could use but
 * not name.
 */

/**
 * Standalone factory for the listAgents tool so it can be shared across
 * multiple tool sets (e.g. agent-discovery AND kanban).
 */
export function createListAgentsTool(ctx: ScopeContext): Tool {
  return tool({
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
  });
}

export function createAgentDiscoveryTools(
  workspaceId: string,
  orgId: string,
  frontendUrl: string | undefined,
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
      // Only providers usable here: a Shared Provider that is not attached to
      // this workspace would be assignable but unresolvable at Chat-turn time,
      // leaving an Agent that cannot run.
      const providers = await listScoped(db, "provider", ctx);
      // Advertise the reference an alias-aware picker would submit — the alias
      // for an aliased model, the concrete id otherwise — regardless of whether
      // the row stores the new per-model objects or a legacy `string[]` (issues
      // #328, #386). This tool is the agentic counterpart of the Agent model
      // picker, so it must offer the same choices: handing back the concrete id
      // of an aliased model would silently opt every agent created this way out
      // of the next repoint (ADR-0017). Only `modelIds` is read, so the row is
      // cast to satisfy the resolver's signature.
      return providers.map(({ row }) => ({
        id: row.id,
        name: row.name,
        modelIds: providerModelReferences(row as unknown as Provider),
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

      // Everything but the avatar key, which is a storage detail the model has no
      // use for. Dropped by name rather than listing the twenty fields that stay,
      // so a column added to `agent` later is included, not silently missed.
      const { avatarKey: _avatarKey, ...rest } = found.row;
      const url = buildResourceUrl(
        frontendUrl,
        orgId,
        workspaceId,
        `agents/${agentId}`,
      );

      return { ...rest, scope: found.scope, ...(url && { url }) };
    },
  });

  return {
    listToolSets,
    listModelProviders,
    listAgents,
    getAgent,
  };
}
