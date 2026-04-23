import { tool, type Tool } from "ai";
import { z } from "zod";
import { and, eq, or, sql } from "drizzle-orm";
import { db } from "../index.ts";
import {
  skill as skillTable,
  agent as agentTable,
  mcp as mcpTable,
  provider as providerTable,
} from "../db/schema.ts";
import { getToolSets } from "../tools/index.ts";
import { dedupeArray } from "../utils.ts";
import { validateSubAgentAssignment } from "../services/sub-agent-validation.ts";
import { getStorage } from "../storage/index.ts";
import { buildResourceUrl } from "../utils/resource-url.ts";

const skillNameRegex = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function createAgentManagementTools(
  workspaceId: string,
  orgId: string,
  frontendUrl: string | undefined,
): Record<string, Tool> {
  // ---------------------------------------------------------------------------
  // Tool-set discovery
  // ---------------------------------------------------------------------------

  const listToolSets = tool({
    description:
      "List all available tool sets and MCP servers. Use the returned IDs when assigning toolSetIds to agents.",
    inputSchema: z.object({}),
    execute: async () => {
      const toolSetsList = Object.entries(getToolSets()).map(
        ([id, toolSet]) => ({
          id,
          name: toolSet.name,
          category: toolSet.category,
          description: toolSet.description,
        }),
      );

      const mcps = await db
        .select()
        .from(mcpTable)
        .where(eq(mcpTable.workspaceId, workspaceId));
      const mcpList = mcps.map((mcp) => ({
        id: mcp.id,
        name: mcp.name,
        category: "MCP",
      }));

      return [...toolSetsList, ...mcpList];
    },
  });

  // ---------------------------------------------------------------------------
  // Provider discovery
  // ---------------------------------------------------------------------------

  const listModelProviders = tool({
    description:
      "List all configured providers and their available model IDs. Use the returned provider IDs and model IDs when creating or updating agents.",
    inputSchema: z.object({}),
    execute: async () => {
      const providers = await db
        .select({
          id: providerTable.id,
          name: providerTable.name,
          modelIds: providerTable.modelIds,
        })
        .from(providerTable)
        .where(
          or(
            eq(providerTable.workspaceId, workspaceId),
            eq(providerTable.organizationId, orgId),
          ),
        );
      return providers;
    },
  });

  // ---------------------------------------------------------------------------
  // Skill tools
  // ---------------------------------------------------------------------------

  const listSkills = tool({
    description: "List all skills in the current workspace.",
    inputSchema: z.object({}),
    execute: async () => {
      const skills = await db
        .select({
          id: skillTable.id,
          name: skillTable.name,
          description: skillTable.description,
          createdAt: skillTable.createdAt,
          updatedAt: skillTable.updatedAt,
        })
        .from(skillTable)
        .where(eq(skillTable.workspaceId, workspaceId));
      return skills;
    },
  });

  const getSkill = tool({
    description: "Get the full content of a skill by name.",
    inputSchema: z.object({
      name: z.string().describe("The name of the skill to retrieve"),
    }),
    execute: async ({ name }) => {
      const result = await db
        .select()
        .from(skillTable)
        .where(
          and(
            eq(skillTable.workspaceId, workspaceId),
            eq(skillTable.name, name),
          ),
        )
        .limit(1);

      if (result.length === 0) {
        return { error: "Skill not found" };
      }

      const url = buildResourceUrl(
        frontendUrl,
        orgId,
        workspaceId,
        `skills/${result[0].id}`,
      );

      return { ...result[0], ...(url && { url }) };
    },
  });

  const upsertSkill = tool({
    description:
      "Create a new skill or update an existing skill by name. If a skill with the given name already exists in this workspace, it will be updated.",
    inputSchema: z.object({
      name: z
        .string()
        .min(5)
        .max(64)
        .regex(skillNameRegex, "Skill name must be kebab-case"),
      description: z.string().min(24).max(128),
      body: z.string().min(48).max(20000),
    }),
    execute: async ({ name, description, body }) => {
      const { nanoid } = await import("nanoid");
      const now = new Date();

      const record = await db
        .insert(skillTable)
        .values({
          id: nanoid(),
          workspaceId,
          name,
          description,
          body,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [skillTable.workspaceId, skillTable.name],
          set: {
            description,
            body,
            updatedAt: now,
          },
        })
        .returning();

      const url = buildResourceUrl(
        frontendUrl,
        orgId,
        workspaceId,
        `skills/${record[0].id}`,
      );

      return { ...record[0], ...(url && { url }) };
    },
  });

  const deleteSkill = tool({
    description:
      "Delete a skill by name. Will fail if the skill is referenced by one or more agents.",
    inputSchema: z.object({
      name: z.string().describe("The name of the skill to delete"),
    }),
    execute: async ({ name }) => {
      const existing = await db
        .select({ id: skillTable.id })
        .from(skillTable)
        .where(
          and(
            eq(skillTable.workspaceId, workspaceId),
            eq(skillTable.name, name),
          ),
        )
        .limit(1);

      if (existing.length === 0) {
        return { error: "Skill not found" };
      }

      const skillId = existing[0].id;

      // Check if any agents reference this skill
      const referencingAgents = await db
        .select({ id: agentTable.id })
        .from(agentTable)
        .where(
          and(
            eq(agentTable.workspaceId, workspaceId),
            sql`${agentTable.skillIds} @> ${JSON.stringify([skillId])}::jsonb`,
          ),
        )
        .limit(1);

      if (referencingAgents.length > 0) {
        return {
          error:
            "Cannot delete skill because it is referenced by one or more agents",
        };
      }

      await db
        .delete(skillTable)
        .where(
          and(
            eq(skillTable.id, skillId),
            eq(skillTable.workspaceId, workspaceId),
          ),
        );

      return { success: true };
    },
  });

  // ---------------------------------------------------------------------------
  // Agent tools
  // ---------------------------------------------------------------------------

  const listAgents = tool({
    description: "List all agents in the current workspace.",
    inputSchema: z.object({}),
    execute: async () => {
      const agents = await db
        .select({
          id: agentTable.id,
          name: agentTable.name,
          description: agentTable.description,
          modelId: agentTable.modelId,
          providerId: agentTable.providerId,
        })
        .from(agentTable)
        .where(eq(agentTable.workspaceId, workspaceId));
      return agents;
    },
  });

  const getAgent = tool({
    description: "Get full agent details by ID (excludes avatar).",
    inputSchema: z.object({
      agentId: z.string().describe("The ID of the agent to retrieve"),
      label: z.string().describe("The agent name (for display purposes)"),
    }),
    execute: async ({ agentId }) => {
      const result = await db
        .select({
          id: agentTable.id,
          workspaceId: agentTable.workspaceId,
          name: agentTable.name,
          description: agentTable.description,
          providerId: agentTable.providerId,
          modelId: agentTable.modelId,
          systemPrompt: agentTable.systemPrompt,
          maxSteps: agentTable.maxSteps,
          temperature: agentTable.temperature,
          topP: agentTable.topP,
          topK: agentTable.topK,
          seed: agentTable.seed,
          presencePenalty: agentTable.presencePenalty,
          frequencyPenalty: agentTable.frequencyPenalty,
          toolSetIds: agentTable.toolSetIds,
          skillIds: agentTable.skillIds,
          subAgentIds: agentTable.subAgentIds,
          inputPlaceholder: agentTable.inputPlaceholder,
          createdAt: agentTable.createdAt,
          updatedAt: agentTable.updatedAt,
        })
        .from(agentTable)
        .where(
          and(
            eq(agentTable.id, agentId),
            eq(agentTable.workspaceId, workspaceId),
          ),
        )
        .limit(1);

      if (result.length === 0) {
        return { error: "Agent not found" };
      }

      const url = buildResourceUrl(
        frontendUrl,
        orgId,
        workspaceId,
        `agents/${agentId}`,
      );

      return { ...result[0], ...(url && { url }) };
    },
  });

  const createAgent = tool({
    description:
      "Create a new agent in the current workspace. Returns the created agent.",
    inputSchema: z.object({
      name: z.string().min(3).max(30).describe("Agent display name"),
      description: z.string().min(1).max(96).describe("Short description"),
      providerId: z.string().describe("Provider ID to use"),
      modelId: z.string().describe("Model ID to use"),
      systemPrompt: z.string().optional().describe("System prompt"),
      maxSteps: z.number().optional().describe("Max agentic steps"),
      temperature: z.number().optional().describe("Sampling temperature"),
      topP: z.number().optional().describe("Top-p sampling"),
      topK: z.number().optional().describe("Top-k sampling"),
      seed: z.number().optional().describe("Random seed"),
      presencePenalty: z.number().optional().describe("Presence penalty"),
      frequencyPenalty: z.number().optional().describe("Frequency penalty"),
      toolSetIds: z
        .array(z.string())
        .optional()
        .describe("Tool set IDs to assign"),
      skillIds: z.array(z.string()).optional().describe("Skill IDs to assign"),
      subAgentIds: z
        .array(z.string())
        .optional()
        .describe("Sub-agent IDs to assign"),
      inputPlaceholder: z
        .string()
        .max(100)
        .optional()
        .describe("Placeholder text for chat input"),
    }),
    execute: async (data) => {
      const { nanoid } = await import("nanoid");

      // Deduplicate arrays
      if (data.toolSetIds) {
        data.toolSetIds = dedupeArray(data.toolSetIds);
      }
      if (data.skillIds) {
        data.skillIds = dedupeArray(data.skillIds);
      }
      if (data.subAgentIds) {
        data.subAgentIds = dedupeArray(data.subAgentIds);
      }

      // Validate sub-agent assignments
      if (data.subAgentIds && data.subAgentIds.length > 0) {
        const newId = nanoid();
        const validation = await validateSubAgentAssignment(
          workspaceId,
          newId,
          data.subAgentIds,
        );
        if (!validation.valid) {
          return { error: validation.error };
        }

        const record = await db
          .insert(agentTable)
          .values({
            id: newId,
            workspaceId,
            ...data,
          })
          .returning();

        const { avatarKey: _a, ...restA } = record[0];
        const urlA = buildResourceUrl(
          frontendUrl,
          orgId,
          workspaceId,
          `agents/${newId}`,
        );
        return { ...restA, ...(urlA && { url: urlA }) };
      }

      const id = nanoid();
      const record = await db
        .insert(agentTable)
        .values({
          id,
          workspaceId,
          ...data,
        })
        .returning();

      const { avatarKey: _, ...rest } = record[0];
      const url = buildResourceUrl(
        frontendUrl,
        orgId,
        workspaceId,
        `agents/${id}`,
      );
      return { ...rest, ...(url && { url }) };
    },
  });

  const updateAgent = tool({
    description: "Update an existing agent by ID. All fields are optional.",
    inputSchema: z.object({
      agentId: z.string().describe("The ID of the agent to update"),
      label: z.string().describe("The agent name (for display purposes)"),
      name: z.string().min(3).max(30).optional().describe("Agent display name"),
      description: z
        .string()
        .min(1)
        .max(96)
        .optional()
        .describe("Short description"),
      providerId: z.string().optional().describe("Provider ID to use"),
      modelId: z.string().optional().describe("Model ID to use"),
      systemPrompt: z.string().optional().describe("System prompt"),
      maxSteps: z.number().optional().describe("Max agentic steps"),
      temperature: z.number().optional().describe("Sampling temperature"),
      topP: z.number().optional().describe("Top-p sampling"),
      topK: z.number().optional().describe("Top-k sampling"),
      seed: z.number().optional().describe("Random seed"),
      presencePenalty: z.number().optional().describe("Presence penalty"),
      frequencyPenalty: z.number().optional().describe("Frequency penalty"),
      toolSetIds: z
        .array(z.string())
        .optional()
        .describe("Tool set IDs to assign"),
      skillIds: z.array(z.string()).optional().describe("Skill IDs to assign"),
      subAgentIds: z
        .array(z.string())
        .optional()
        .describe("Sub-agent IDs to assign"),
      inputPlaceholder: z
        .string()
        .max(100)
        .optional()
        .describe("Placeholder text for chat input"),
    }),
    execute: async ({ agentId, label: _label, ...data }) => {
      // Deduplicate arrays
      if (data.toolSetIds) {
        data.toolSetIds = dedupeArray(data.toolSetIds);
      }
      if (data.skillIds) {
        data.skillIds = dedupeArray(data.skillIds);
      }
      if (data.subAgentIds) {
        data.subAgentIds = dedupeArray(data.subAgentIds);
      }

      // Validate sub-agent assignments
      if (data.subAgentIds) {
        const validation = await validateSubAgentAssignment(
          workspaceId,
          agentId,
          data.subAgentIds,
        );
        if (!validation.valid) {
          return { error: validation.error };
        }
      }

      const record = await db
        .update(agentTable)
        .set({
          ...data,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(agentTable.id, agentId),
            eq(agentTable.workspaceId, workspaceId),
          ),
        )
        .returning();

      if (record.length === 0) {
        return { error: "Agent not found" };
      }

      const { avatarKey: _, ...rest } = record[0];
      const url = buildResourceUrl(
        frontendUrl,
        orgId,
        workspaceId,
        `agents/${agentId}`,
      );
      return { ...rest, ...(url && { url }) };
    },
  });

  const deleteAgent = tool({
    description: "Delete an agent by ID. Also cleans up the agent's avatar.",
    inputSchema: z.object({
      agentId: z.string().describe("The ID of the agent to delete"),
      label: z.string().describe("The agent name (for display purposes)"),
    }),
    execute: async ({ agentId }) => {
      const existing = await db
        .select({ avatarKey: agentTable.avatarKey })
        .from(agentTable)
        .where(
          and(
            eq(agentTable.id, agentId),
            eq(agentTable.workspaceId, workspaceId),
          ),
        )
        .limit(1);

      if (existing.length === 0) {
        return { error: "Agent not found" };
      }

      if (existing[0]?.avatarKey) {
        try {
          const storage = getStorage();
          await storage.delete(existing[0].avatarKey);
        } catch {
          // Ignore deletion errors
        }
      }

      await db
        .delete(agentTable)
        .where(
          and(
            eq(agentTable.id, agentId),
            eq(agentTable.workspaceId, workspaceId),
          ),
        );

      return { success: true };
    },
  });

  return {
    listToolSets,
    listModelProviders,
    listSkills,
    getSkill,
    upsertSkill,
    deleteSkill,
    listAgents,
    getAgent,
    createAgent,
    updateAgent,
    deleteAgent,
  };
}
