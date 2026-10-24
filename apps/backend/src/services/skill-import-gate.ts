import { count, eq } from "drizzle-orm";
import {
  gateAdmits,
  type OrgGate,
  type OrgGateAccess,
  type OrgGateAccessUpdate,
} from "@platypus/schemas";
import { db } from "../index.ts";
import {
  organization as organizationTable,
  skill as skillTable,
  workspace as workspaceTable,
} from "../db/schema.ts";
import { getGateAccess, setGateAccess } from "./org-gate.ts";

/**
 * The Organization gate on importing Skill bundles into a Workspace — zip
 * import, Replace bundle and GitHub install (ADR-0037). It stops third-party
 * bundles, not instructions typed into a Skill. Organization-scope imports,
 * which only an Org Admin makes, are never gated.
 */
const SKILL_IMPORT_GATE = {
  gate: "skillImportGate",
  allowed: "skillImportAllowed",
  resourceCounts: (orgId: string) =>
    db
      .select({ workspaceId: workspaceTable.id, count: count() })
      .from(skillTable)
      .innerJoin(workspaceTable, eq(workspaceTable.id, skillTable.workspaceId))
      .where(eq(workspaceTable.organizationId, orgId))
      .groupBy(workspaceTable.id),
  changedMessage: "Skill import access changed by an Org Admin",
} as const;

export const getSkillImportAccess = (orgId: string): Promise<OrgGateAccess> =>
  getGateAccess(SKILL_IMPORT_GATE, orgId);

export const setSkillImportAccess = (
  orgId: string,
  update: OrgGateAccessUpdate,
  actorUserId: string,
): Promise<OrgGateAccess> =>
  setGateAccess(SKILL_IMPORT_GATE, orgId, update, actorUserId);

/** Whether the Organization's gate lets this Workspace import Skill bundles. */
export const skillImportAllowed = async (
  workspaceId: string,
): Promise<boolean> => {
  const [row] = await db
    .select({
      gate: organizationTable.skillImportGate,
      allowed: workspaceTable.skillImportAllowed,
    })
    .from(workspaceTable)
    .innerJoin(
      organizationTable,
      eq(organizationTable.id, workspaceTable.organizationId),
    )
    .where(eq(workspaceTable.id, workspaceId))
    .limit(1);
  return !!row && gateAdmits(row.gate as OrgGate, row.allowed);
};
