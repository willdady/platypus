import { tool, type Tool } from "ai";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "../index.ts";
import { agent as agentTable } from "../db/schema.ts";
import { dedupeArray } from "../utils.ts";
import { validateSubAgentAssignment } from "../services/sub-agent-validation.ts";
import {
  resolveScoped,
  workspaceMutationLockedMessage,
  type ScopeContext,
} from "../services/scoped-resource.ts";
import { getStorage } from "../storage/index.ts";
import { buildResourceUrl } from "../utils/resource-url.ts";

// Shared by the create and update tools so the two cannot drift. Tells the
// model that Instructions are only the first fragment of the composed system
// prompt, so it does not generate boilerplate Platypus already supplies.
const INSTRUCTIONS_DESCRIPTION =
  "The agent's own instructions — how it should behave. Platypus composes the full system prompt around this, adding workspace and user context, memories, Skills, sub-agents and the provider's security guardrails, so do not restate those here.";

// Also shared, for the same reason. An 'alias:<name>' value is a Model alias
// (ADR-0017) and must be stored as-is: rewriting it to the vendor model id it
// points at pins the agent to today's model and opts it out of future repoints.
const MODEL_ID_DESCRIPTION =
  "Model ID to use, exactly as listModelProviders returned it — including an 'alias:<name>' value, which must not be replaced with the vendor model id it points at.";

export function createAgentManagementTools(
  workspaceId: string,
  orgId: string,
  frontendUrl: string | undefined,
): Record<string, Tool> {
  const ctx: ScopeContext = { orgId, wsId: workspaceId };

  /**
   * Resolves an Agent this Workspace may write to, for the mutating tools. An
   * attached Shared Agent is visible here but is a single source of truth edited
   * only on the Organization surface (ADR-0007) — the same rule
   * `requireWorkspaceMutable` enforces on the routes, in the same words,
   * returned rather than thrown because a tool answers the model with an
   * `{ error }` payload.
   */
  const resolveWritableAgent = async (
    agentId: string,
  ): Promise<{ row: typeof agentTable.$inferSelect } | { error: string }> => {
    const found = await resolveScoped(db, "agent", agentId, ctx);
    if (!found) return { error: "Agent not found" };
    if (found.scope === "organization") {
      return { error: workspaceMutationLockedMessage("agent") };
    }
    return { row: found.row };
  };

  const createAgent = tool({
    description:
      "Create a new agent in the current workspace. Returns the created agent.",
    inputSchema: z.object({
      name: z.string().min(3).max(30).describe("Agent display name"),
      description: z.string().min(1).max(128).describe("Short description"),
      providerId: z.string().describe("Provider ID to use"),
      modelId: z.string().describe(MODEL_ID_DESCRIPTION),
      instructions: z.string().optional().describe(INSTRUCTIONS_DESCRIPTION),
      maxSteps: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Max agentic steps, at least 1"),
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
      if (data.subAgentIds) {
        data.subAgentIds = dedupeArray(data.subAgentIds);
      }

      if (data.subAgentIds && data.subAgentIds.length > 0) {
        const newId = nanoid();
        const validation = await validateSubAgentAssignment(
          { orgId, wsId: workspaceId },
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
        .max(128)
        .optional()
        .describe("Short description"),
      providerId: z.string().optional().describe("Provider ID to use"),
      modelId: z.string().optional().describe(MODEL_ID_DESCRIPTION),
      instructions: z.string().optional().describe(INSTRUCTIONS_DESCRIPTION),
      maxSteps: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Max agentic steps, at least 1"),
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
      if (data.subAgentIds) {
        data.subAgentIds = dedupeArray(data.subAgentIds);
      }

      // Before validating the payload: a Shared Agent should be refused as
      // locked, not answered with a complaint about the edit it will not apply.
      const writable = await resolveWritableAgent(agentId);
      if ("error" in writable) return writable;

      if (data.subAgentIds) {
        const validation = await validateSubAgentAssignment(
          ctx,
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
      // Detaching a Shared Agent is the workspace-side action, and that is an
      // Attachment concern — never a delete of the Organization's row.
      const writable = await resolveWritableAgent(agentId);
      if ("error" in writable) return writable;

      if (writable.row.avatarKey) {
        try {
          const storage = getStorage();
          await storage.delete(writable.row.avatarKey);
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
