import { db } from "../index.ts";
import {
  agent as agentTable,
  mcp as mcpTable,
  provider as providerTable,
  skill as skillTable,
} from "../db/schema.ts";
import { eq, inArray } from "drizzle-orm";
import { hasToolSet } from "../tools/index.ts";
import { isSharedRow } from "./scoped-resource.ts";

export type ReferenceBlocker = {
  type: "provider" | "skill" | "subAgent" | "mcp";
  id: string;
  name: string;
};

type AgentReferences = {
  providerId: string;
  fallbackProviderId?: string | null;
  skillIds?: string[] | null;
  subAgentIds?: string[] | null;
  toolSetIds?: string[] | null;
};

export const findNonSharedReferences = async (
  orgId: string,
  refs: AgentReferences,
): Promise<ReferenceBlocker[]> => {
  const blockers: ReferenceBlocker[] = [];

  const providerRows = await db
    .select({
      id: providerTable.id,
      name: providerTable.name,
      organizationId: providerTable.organizationId,
      workspaceId: providerTable.workspaceId,
    })
    .from(providerTable)
    .where(eq(providerTable.id, refs.providerId));
  const prov = providerRows[0];
  if (!isSharedRow(prov, orgId)) {
    blockers.push({
      type: "provider",
      id: refs.providerId,
      name: prov?.name ?? refs.providerId,
    });
  }

  if (refs.fallbackProviderId) {
    const [fallback] = await db
      .select({
        id: providerTable.id,
        name: providerTable.name,
        organizationId: providerTable.organizationId,
        workspaceId: providerTable.workspaceId,
      })
      .from(providerTable)
      .where(eq(providerTable.id, refs.fallbackProviderId));
    if (!isSharedRow(fallback, orgId)) {
      blockers.push({
        type: "provider",
        id: refs.fallbackProviderId,
        name: fallback?.name ?? refs.fallbackProviderId,
      });
    }
  }

  const skillIds = refs.skillIds ?? [];
  if (skillIds.length > 0) {
    const rows = await db
      .select({
        id: skillTable.id,
        name: skillTable.name,
        organizationId: skillTable.organizationId,
        workspaceId: skillTable.workspaceId,
      })
      .from(skillTable)
      .where(inArray(skillTable.id, skillIds));
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const id of skillIds) {
      const row = byId.get(id);
      if (!isSharedRow(row, orgId)) {
        blockers.push({ type: "skill", id, name: row?.name ?? id });
      }
    }
  }

  const subAgentIds = refs.subAgentIds ?? [];
  if (subAgentIds.length > 0) {
    const rows = await db
      .select({
        id: agentTable.id,
        name: agentTable.name,
        organizationId: agentTable.organizationId,
        workspaceId: agentTable.workspaceId,
      })
      .from(agentTable)
      .where(inArray(agentTable.id, subAgentIds));
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const id of subAgentIds) {
      const row = byId.get(id);
      if (!isSharedRow(row, orgId)) {
        blockers.push({ type: "subAgent", id, name: row?.name ?? id });
      }
    }
  }

  const toolSetIds = refs.toolSetIds ?? [];
  const mcpIds = toolSetIds.filter((id) => !hasToolSet(id));
  if (mcpIds.length > 0) {
    const rows = await db
      .select({
        id: mcpTable.id,
        name: mcpTable.name,
        organizationId: mcpTable.organizationId,
        workspaceId: mcpTable.workspaceId,
      })
      .from(mcpTable)
      .where(inArray(mcpTable.id, mcpIds));
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const id of mcpIds) {
      const row = byId.get(id);
      if (!isSharedRow(row, orgId)) {
        blockers.push({ type: "mcp", id, name: row?.name ?? id });
      }
    }
  }

  return blockers;
};
