import { db } from "../index.ts";
import {
  agent as agentTable,
  mcp as mcpTable,
  provider as providerTable,
  skill as skillTable,
} from "../db/schema.ts";
import { eq, inArray } from "drizzle-orm";
import { getToolSets } from "../tools/index.ts";

/**
 * A reference that blocks Promotion because it is not itself Organization-scoped
 * (ADR-0007 no-cascade rule). `name` is included so the UI can render a
 * fix-this checklist that names the offending Workspace-private references.
 */
export type ReferenceBlocker = {
  type: "provider" | "skill" | "subAgent" | "mcp";
  id: string;
  name: string;
};

type AgentReferences = {
  providerId: string;
  skillIds?: string[] | null;
  subAgentIds?: string[] | null;
  toolSetIds?: string[] | null;
};

/**
 * The defining rule of a Shared resource: it may reference only other Shared
 * (Organization-scoped) resources (ADR-0007). Returns every reference of the
 * given Agent that is NOT org-scoped and therefore blocks Promotion — an empty
 * array means the Agent is safe to promote.
 *
 * Reference buckets (ADR-0007 Consequences):
 * - **travels-with** — `providerId`, `skillIds`, `subAgentIds`, and MCP-backed
 *   tool sets must already be Organization-scoped; each that isn't is a blocker.
 * - **rebinds-per-Workspace** — the Sandbox tool set is statically registered
 *   and rebinds to the invoking Workspace at Chat-turn time, so it never blocks.
 * - **always-available** — every other statically registered tool set is always
 *   present and never blocks.
 *
 * Any tool-set id that is not a statically registered set is treated as an
 * MCP-backed tool set and must resolve to an Organization-scoped MCP.
 */
export const findNonSharedReferences = async (
  orgId: string,
  refs: AgentReferences,
): Promise<ReferenceBlocker[]> => {
  const blockers: ReferenceBlocker[] = [];

  // Provider — exactly one, always required.
  const providerRows = await db
    .select({
      id: providerTable.id,
      name: providerTable.name,
      organizationId: providerTable.organizationId,
    })
    .from(providerTable)
    .where(eq(providerTable.id, refs.providerId));
  const prov = providerRows[0];
  if (!prov || prov.organizationId !== orgId) {
    blockers.push({
      type: "provider",
      id: refs.providerId,
      name: prov?.name ?? refs.providerId,
    });
  }

  // Skills — each must be org-scoped.
  const skillIds = refs.skillIds ?? [];
  if (skillIds.length > 0) {
    const rows = await db
      .select({
        id: skillTable.id,
        name: skillTable.name,
        organizationId: skillTable.organizationId,
      })
      .from(skillTable)
      .where(inArray(skillTable.id, skillIds));
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const id of skillIds) {
      const row = byId.get(id);
      if (!row || row.organizationId !== orgId) {
        blockers.push({ type: "skill", id, name: row?.name ?? id });
      }
    }
  }

  // Sub-Agents — each must be org-scoped.
  const subAgentIds = refs.subAgentIds ?? [];
  if (subAgentIds.length > 0) {
    const rows = await db
      .select({
        id: agentTable.id,
        name: agentTable.name,
        organizationId: agentTable.organizationId,
      })
      .from(agentTable)
      .where(inArray(agentTable.id, subAgentIds));
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const id of subAgentIds) {
      const row = byId.get(id);
      if (!row || row.organizationId !== orgId) {
        blockers.push({ type: "subAgent", id, name: row?.name ?? id });
      }
    }
  }

  // Tool sets — statically registered sets (including the Sandbox set) are
  // always allowed; any other id is an MCP-backed tool set and must resolve to
  // an org-scoped MCP.
  const toolSetIds = refs.toolSetIds ?? [];
  const registry = getToolSets();
  const mcpIds = toolSetIds.filter((id) => !(id in registry));
  if (mcpIds.length > 0) {
    const rows = await db
      .select({
        id: mcpTable.id,
        name: mcpTable.name,
        organizationId: mcpTable.organizationId,
      })
      .from(mcpTable)
      .where(inArray(mcpTable.id, mcpIds));
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const id of mcpIds) {
      const row = byId.get(id);
      if (!row || row.organizationId !== orgId) {
        blockers.push({ type: "mcp", id, name: row?.name ?? id });
      }
    }
  }

  return blockers;
};
