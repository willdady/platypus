import { and, eq, inArray, notInArray } from "drizzle-orm";
import type { OrgGateAccess, OrgGateAccessUpdate } from "@platypus/schemas";
import { db } from "../index.ts";
import {
  organization as organizationTable,
  user as userTable,
  workspace as workspaceTable,
} from "../db/schema.ts";
import { NotFoundError } from "../errors.ts";
import { logger } from "../logger.ts";

type GateKind = {
  gate: "inboundTriggerGate" | "a2aGate" | "skillImportGate";
  allowed: "inboundTriggersAllowed" | "a2aAllowed" | "skillImportAllowed";
  resourceCounts: (
    orgId: string,
  ) => Promise<{ workspaceId: string; count: number }[]>;
  changedMessage: string;
};

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
    gate: org?.gate ?? "off",
    workspaces: workspaces
      .map((workspace) => ({
        ...workspace,
        count: counts.get(workspace.id) ?? 0,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
};

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
      // why: only rows whose switch changes, so a Workspace's updatedAt still means it changed
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
