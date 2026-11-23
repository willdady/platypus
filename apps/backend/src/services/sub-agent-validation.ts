import { db } from "../index.ts";
import { listScopedByIds } from "./scoped-resource.ts";
import type { ScopeContext } from "../scope.ts";

export const SUB_AGENT_SELF_ASSIGNMENT_ERROR =
  "An agent cannot assign itself as a sub-agent";

export const validateSubAgentAssignment = async (
  ctx: ScopeContext,
  agentId: string,
  subAgentIds: string[],
): Promise<{ valid: true } | { valid: false; error: string }> => {
  if (subAgentIds.includes(agentId)) {
    return { valid: false, error: SUB_AGENT_SELF_ASSIGNMENT_ERROR };
  }

  const visible = await listScopedByIds(db, "agent", subAgentIds, ctx);
  const visibleIds = new Set(visible.map(({ row }) => row.id));

  if (subAgentIds.some((id) => !visibleIds.has(id))) {
    return {
      valid: false,
      error: "One or more sub-agents are not available in this workspace",
    };
  }

  return { valid: true };
};
