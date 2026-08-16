import { tool, type Tool } from "ai";
import { z } from "zod";
import { agentBaseSchema } from "@platypus/schemas";
import {
  createAgent as createAgentRow,
  updateAgent as updateAgentRow,
  deleteAgent as deleteAgentRow,
  type AgentWriteError,
} from "../services/agent.ts";
import { LockedError, NotFoundError } from "../errors.ts";
import type { ScopeContext } from "../scope.ts";
import { buildResourceUrl } from "../utils/resource-url.ts";

// Field constraints come from the shared schema so the agent-facing tool can
// never drift from the bounds the HTTP routes and the web form enforce — the
// six sampling params are nullable so an Agent can clear one back to unset
// (#263), the same as the routes.
const agentFields = agentBaseSchema.shape;

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
  const ctx: ScopeContext = { orgId, workspaceId };

  /**
   * Turns `updateAgent`/`deleteAgent`'s thrown `NotFoundError`/`LockedError`
   * into the `{ error }` payload a Tool result carries — a Tool reports a
   * problem back to the model rather than throwing it into the run. The same
   * rule `requireWorkspaceMutable` enforces on the routes, in the same words
   * (an attached Shared Agent is a single source of truth edited only on the
   * Organization surface — ADR-0007).
   */
  async function asToolResult<T>(
    run: () => Promise<T>,
  ): Promise<T | AgentWriteError> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof NotFoundError || error instanceof LockedError) {
        return { error: error.message };
      }
      throw error;
    }
  }

  const createAgent = tool({
    description:
      "Create a new agent in the current workspace. Returns the created agent.",
    inputSchema: z.object({
      name: agentFields.name.describe("Agent display name"),
      description: agentFields.description.describe("Short description"),
      providerId: agentFields.providerId.describe("Provider ID to use"),
      modelId: agentFields.modelId.describe(MODEL_ID_DESCRIPTION),
      instructions: agentFields.instructions.describe(INSTRUCTIONS_DESCRIPTION),
      maxSteps: agentFields.maxSteps.describe("Max agentic steps, at least 1"),
      temperature: agentFields.temperature.describe("Sampling temperature"),
      topP: agentFields.topP.describe("Top-p sampling"),
      topK: agentFields.topK.describe("Top-k sampling"),
      seed: agentFields.seed.describe("Random seed"),
      presencePenalty: agentFields.presencePenalty.describe("Presence penalty"),
      frequencyPenalty:
        agentFields.frequencyPenalty.describe("Frequency penalty"),
      toolSetIds: agentFields.toolSetIds.describe("Tool set IDs to assign"),
      skillIds: agentFields.skillIds.describe("Skill IDs to assign"),
      subAgentIds: agentFields.subAgentIds.describe("Sub-agent IDs to assign"),
      inputPlaceholder: agentFields.inputPlaceholder.describe(
        "Placeholder text for chat input",
      ),
    }),
    execute: async (data) => {
      const result = await createAgentRow(ctx, data);
      if ("error" in result) return result;

      const { avatarKey: _, ...rest } = result.row;
      const url = buildResourceUrl(
        frontendUrl,
        orgId,
        workspaceId,
        `agents/${result.row.id}`,
      );
      return { ...rest, ...(url && { url }) };
    },
  });

  const updateAgent = tool({
    description: "Update an existing agent by ID. All fields are optional.",
    inputSchema: z.object({
      agentId: z.string().describe("The ID of the agent to update"),
      label: z.string().describe("The agent name (for display purposes)"),
      name: agentFields.name.optional().describe("Agent display name"),
      description: agentFields.description
        .optional()
        .describe("Short description"),
      providerId: agentFields.providerId
        .optional()
        .describe("Provider ID to use"),
      modelId: agentFields.modelId.optional().describe(MODEL_ID_DESCRIPTION),
      instructions: agentFields.instructions.describe(INSTRUCTIONS_DESCRIPTION),
      maxSteps: agentFields.maxSteps.describe("Max agentic steps, at least 1"),
      temperature: agentFields.temperature.describe("Sampling temperature"),
      topP: agentFields.topP.describe("Top-p sampling"),
      topK: agentFields.topK.describe("Top-k sampling"),
      seed: agentFields.seed.describe("Random seed"),
      presencePenalty: agentFields.presencePenalty.describe("Presence penalty"),
      frequencyPenalty:
        agentFields.frequencyPenalty.describe("Frequency penalty"),
      toolSetIds: agentFields.toolSetIds.describe("Tool set IDs to assign"),
      skillIds: agentFields.skillIds.describe("Skill IDs to assign"),
      subAgentIds: agentFields.subAgentIds.describe("Sub-agent IDs to assign"),
      inputPlaceholder: agentFields.inputPlaceholder.describe(
        "Placeholder text for chat input",
      ),
    }),
    execute: async ({ agentId, label: _label, ...data }) =>
      asToolResult(async () => {
        const result = await updateAgentRow(ctx, agentId, data);
        if ("error" in result) return result;

        const { avatarKey: _, ...rest } = result.row;
        const url = buildResourceUrl(
          frontendUrl,
          orgId,
          workspaceId,
          `agents/${agentId}`,
        );
        return { ...rest, ...(url && { url }) };
      }),
  });

  const deleteAgent = tool({
    description: "Delete an agent by ID. Also cleans up the agent's avatar.",
    inputSchema: z.object({
      agentId: z.string().describe("The ID of the agent to delete"),
      label: z.string().describe("The agent name (for display purposes)"),
    }),
    execute: async ({ agentId }) =>
      asToolResult(async () => {
        await deleteAgentRow(ctx, agentId);
        return { success: true };
      }),
  });

  return {
    createAgent,
    updateAgent,
    deleteAgent,
  };
}
