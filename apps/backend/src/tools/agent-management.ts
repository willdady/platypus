import { tool, type Tool } from "ai";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "../index.ts";
import { agent as agentTable } from "../db/schema.ts";
import { dedupeArray } from "../utils.ts";
import { validateSubAgentAssignment } from "../services/sub-agent-validation.ts";
import { getStorage } from "../storage/index.ts";
import { buildResourceUrl } from "../utils/resource-url.ts";

export function createAgentManagementTools(
  workspaceId: string,
  orgId: string,
  frontendUrl: string | undefined,
): Record<string, Tool> {
  const createAgent = tool({
    description:
      "Create a new agent in the current workspace. Returns the created agent.",
    inputSchema: z.object({
      name: z.string().min(3).max(30).describe("Agent display name"),
      description: z.string().min(1).max(128).describe("Short description"),
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

      if (data.toolSetIds) {
        data.toolSetIds = dedupeArray(data.toolSetIds);
      }
      if (data.skillIds) {
        data.skillIds = dedupeArray(data.skillIds);
      }
      // Convert string[] → {id}[] and deduplicate
      const subAgentRefs = data.subAgentIds
        ? [...new Map(data.subAgentIds.map((id) => [id, { id }])).values()]
        : undefined;

      if (subAgentRefs && subAgentRefs.length > 0) {
        const newId = nanoid();
        const validation = await validateSubAgentAssignment(
          workspaceId,
          newId,
          subAgentRefs,
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
            subAgentIds: subAgentRefs,
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
          ...(subAgentRefs !== undefined && { subAgentIds: subAgentRefs }),
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
        .max(128)
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
      if (data.toolSetIds) {
        data.toolSetIds = dedupeArray(data.toolSetIds);
      }
      if (data.skillIds) {
        data.skillIds = dedupeArray(data.skillIds);
      }
      // Convert string[] → {id}[] and deduplicate
      const subAgentRefs = data.subAgentIds
        ? [...new Map(data.subAgentIds.map((id) => [id, { id }])).values()]
        : undefined;

      if (subAgentRefs) {
        const validation = await validateSubAgentAssignment(
          workspaceId,
          agentId,
          subAgentRefs,
        );
        if (!validation.valid) {
          return { error: validation.error };
        }
      }

      const record = await db
        .update(agentTable)
        .set({
          ...data,
          ...(subAgentRefs !== undefined && { subAgentIds: subAgentRefs }),
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
    createAgent,
    updateAgent,
    deleteAgent,
  };
}
