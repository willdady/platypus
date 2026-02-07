import { db } from "../index.ts";
import { agent as agentTable } from "../db/schema.ts";
import { and, eq, inArray } from "drizzle-orm";

export const validateSubAgentAssignment = async (
  workspaceId: string,
  agentId: string,
  subAgentIds: string[]
): Promise<{ valid: boolean; error?: string }> => {
  // 1. Check self-assignment
  if (subAgentIds.includes(agentId)) {
    return { valid: false, error: "An agent cannot assign itself as a sub-agent" };
  }

  // 2. Fetch all proposed sub-agents
  const subAgents = await db
    .select()
    .from(agentTable)
    .where(
      and(
        eq(agentTable.workspaceId, workspaceId),
        inArray(agentTable.id, subAgentIds)
      )
    );

  // 3. Verify all sub-agents exist in workspace
  if (subAgents.length !== subAgentIds.length) {
    return { valid: false, error: "One or more sub-agents not found in workspace" };
  }

  // Note: We allow agents that have their own sub-agents to BE sub-agents.
  // The depth limit is enforced at runtime - when an agent runs as a sub-agent,
  // the newTask tool is NOT injected, preventing nested delegation.

  return { valid: true };
};
