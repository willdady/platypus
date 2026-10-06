import { and, eq, inArray, notInArray } from "drizzle-orm";
import type {
  OrgGateAccess,
  OrgGateAccessUpdate,
  OrgGate,
} from "@platypus/schemas";
import { db } from "../index.ts";
import {
  organization as organizationTable,
  user as userTable,
  workspace as workspaceTable,
} from "../db/schema.ts";
import { NotFoundError } from "../errors.ts";
import { logger } from "../logger.ts";

/**
 * An Organization gate on a way in from outside: off, every Workspace, or the
 * Workspaces whose own switch is on. Inbound Triggers (ADR-0030) and A2A
 * endpoints (ADR-0032) each have one, in the same shape and stored side by
 * side, so the reading and saving live here once.
 */
type GateKind = {
  gate: "inboundTriggerGate" | "a2aGate";
  allowed: "inboundTriggersAllowed" | "a2aAllowed";
  /** How many resources the gate admits each Workspace holds, if any. */
  resourceCounts: (
    orgId: string,
  ) => Promise<{ workspaceId: string; count: number }[]>;
  /** The info line an Org Admin's change writes. */
  changedMessage: string;
};

/**
 * The gate and every Workspace with its own switch and how many of the gated
 * resources it holds, so the Admin can see which ones a change would cut off.
 */
export const getGateAccess = async (
  kind: GateKind,
  orgId: string,
): Promise<OrgGateAccess> => {
  const [org] = await db
    .select({ gate: organizationTable[kind.gate] })
    .from(organizationTable)
    .where(eq(organizationTable.id, orgId))
    .limit(1);
  const workspaces = await db
    .select({
      id: workspaceTable.id,
      name: workspaceTable.name,
      allowed: workspaceTable[kind.allowed],
      ownerName: userTable.name,
    })
    .from(workspaceTable)
    .innerJoin(userTable, eq(userTable.id, workspaceTable.ownerId))
    .where(eq(workspaceTable.organizationId, orgId));
  const counts = new Map(
    (await kind.resourceCounts(orgId)).map((row) => [
      row.workspaceId,
      row.count,
    ]),
  );
  return {
    gate: (org?.gate ?? "off") as OrgGate,
    workspaces: workspaces
      .map((workspace) => ({
        ...workspace,
        count: counts.get(workspace.id) ?? 0,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
};

/**
 * Saves the gate and, when `allowedWorkspaceIds` is given, every Workspace's
 * switch with it: on for those listed, off for the rest. One transaction, so a
 * switch to `selected` takes effect with the Workspaces it should keep already
 * allowed. A listed id outside the Organization refuses the whole save.
 */
export const setGateAccess = async (
  kind: GateKind,
  orgId: string,
  update: OrgGateAccessUpdate,
  actorUserId: string,
): Promise<OrgGateAccess> => {
  const allowedColumn = workspaceTable[kind.allowed];
  const allowedIds = update.allowedWorkspaceIds
    ? [...new Set(update.allowedWorkspaceIds)]
    : null;
  if (allowedIds && allowedIds.length > 0) {
    const found = await db
      .select({ id: workspaceTable.id })
      .from(workspaceTable)
      .where(
        and(
          eq(workspaceTable.organizationId, orgId),
          inArray(workspaceTable.id, allowedIds),
        ),
      );
    if (found.length !== allowedIds.length) {
      throw new NotFoundError("Workspace not found in this organization");
    }
  }

  await db.transaction(async (tx) => {
    if (allowedIds) {
      const now = new Date();
      // Only rows whose switch changes are written, so a Workspace's
      // updatedAt still means something changed on it.
      if (allowedIds.length > 0) {
        await tx
          .update(workspaceTable)
          .set({ [kind.allowed]: true, updatedAt: now })
          .where(
            and(
              eq(workspaceTable.organizationId, orgId),
              inArray(workspaceTable.id, allowedIds),
              eq(allowedColumn, false),
            ),
          );
      }
      await tx
        .update(workspaceTable)
        .set({ [kind.allowed]: false, updatedAt: now })
        .where(
          and(
            eq(workspaceTable.organizationId, orgId),
            eq(allowedColumn, true),
            allowedIds.length > 0
              ? notInArray(workspaceTable.id, allowedIds)
              : undefined,
          ),
        );
    }
    await tx
      .update(organizationTable)
      .set({ [kind.gate]: update.gate, updatedAt: new Date() })
      .where(eq(organizationTable.id, orgId));
  });

  // Who opened or closed a way in from outside, and how wide.
  logger.info(
    {
      organizationId: orgId,
      userId: actorUserId,
      gate: update.gate,
      allowedWorkspaceCount: allowedIds?.length,
    },
    kind.changedMessage,
  );
  return getGateAccess(kind, orgId);
};
