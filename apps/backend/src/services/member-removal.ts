import { and, eq } from "drizzle-orm";
import type { MemberWorkspaceDecision } from "@platypus/schemas";
import { db, type Tx } from "../index.ts";
import {
  organizationMember,
  workspace as workspaceTable,
} from "../db/schema.ts";
import { ValidationError } from "../errors.ts";
import {
  deleteWorkspaceRows,
  prepareWorkspaceCleanup,
} from "./workspace-delete.ts";
import {
  applyWorkspaceTransfer,
  finishTransfer,
  type TransferAftermath,
} from "./workspace-transfer.ts";
import { findLossTarget, requireAdminRemains } from "./last-admin-guard.ts";

const ownedWorkspaces = (
  database: typeof db | Tx,
  orgId: string,
  userId: string,
) =>
  database
    .select({ id: workspaceTable.id })
    .from(workspaceTable)
    .where(
      and(
        eq(workspaceTable.organizationId, orgId),
        eq(workspaceTable.ownerId, userId),
      ),
    );

const requireEachOwnedDecided = (
  owned: { id: string }[],
  workspaces: MemberWorkspaceDecision[],
) => {
  const decided = new Set(workspaces.map(({ workspaceId }) => workspaceId));
  if (
    decided.size !== workspaces.length ||
    decided.size !== owned.length ||
    owned.some(({ id }) => !decided.has(id))
  ) {
    throw new ValidationError(
      "Choose Transfer or Delete for each Workspace the member owns",
    );
  }
};

export const removeMember = async ({
  orgId,
  memberId,
  actorUserId,
  workspaces,
  transferredBy,
}: {
  orgId: string;
  memberId: string;
  actorUserId: string;
  workspaces: MemberWorkspaceDecision[];
  transferredBy: string;
}): Promise<void> => {
  const request = {
    orgId,
    memberId,
    actorUserId,
    loss: "remove" as const,
  };
  const member = await findLossTarget(db, request);
  requireEachOwnedDecided(
    await ownedWorkspaces(db, orgId, member.userId),
    workspaces,
  );

  const cleanups = await Promise.all(
    workspaces
      .filter(({ action }) => action === "delete")
      .map(({ workspaceId }) =>
        prepareWorkspaceCleanup({ orgId, workspaceId }),
      ),
  );

  const transfers = await db.transaction(async (tx) => {
    // why: first, so the Organization lock is taken before the member-row and Workspace locks
    await requireAdminRemains(tx, request);
    await tx
      .select({ id: organizationMember.id })
      .from(organizationMember)
      .where(eq(organizationMember.id, member.id))
      .for("update");
    // why: locked, so an in-flight transfer finishes first and its Workspace drops out of the set
    requireEachOwnedDecided(
      await ownedWorkspaces(tx, orgId, member.userId).for("update"),
      workspaces,
    );
    const aftermaths: TransferAftermath[] = [];
    for (const decision of workspaces) {
      if (decision.action === "transfer") {
        aftermaths.push(
          await applyWorkspaceTransfer(tx, {
            orgId,
            workspaceId: decision.workspaceId,
            newOwnerId: decision.newOwnerId,
            keepHistory: decision.keepHistory,
            transferredBy,
          }),
        );
      } else {
        await deleteWorkspaceRows(tx, decision.workspaceId);
      }
    }
    await tx
      .delete(organizationMember)
      .where(eq(organizationMember.id, member.id));
    return aftermaths;
  });

  await Promise.all(transfers.map(finishTransfer));
  await Promise.all(cleanups.map((cleanUp) => cleanUp()));
};
