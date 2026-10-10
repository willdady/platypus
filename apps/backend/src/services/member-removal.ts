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

/**
 * Remove from Org (ADR-0035). Every Workspace the member owns in the
 * Organization is transferred or deleted, as `workspaces` decides, and the
 * membership goes with them in one transaction: if any decision is refused,
 * nothing changes and the member stays. Throws `ValidationError` unless
 * `workspaces` decides each owned Workspace exactly once.
 */
export const removeMember = async ({
  orgId,
  member,
  workspaces,
  transferredBy,
}: {
  orgId: string;
  member: { id: string; userId: string };
  workspaces: MemberWorkspaceDecision[];
  transferredBy: string;
}): Promise<void> => {
  requireEachOwnedDecided(
    await ownedWorkspaces(db, orgId, member.userId),
    workspaces,
  );

  // Read before the transaction, while the rows exist; run only after it
  // commits, so a refused removal tears nothing down.
  const cleanups = await Promise.all(
    workspaces
      .filter(({ action }) => action === "delete")
      .map(({ workspaceId }) =>
        prepareWorkspaceCleanup({ orgId, workspaceId }),
      ),
  );

  const transfers = await db.transaction(async (tx) => {
    // Workspace creation holds this row while it adds one for the member, so
    // with it locked the owned set cannot grow before the removal commits.
    await tx
      .select({ id: organizationMember.id })
      .from(organizationMember)
      .where(eq(organizationMember.id, member.id))
      .for("update");
    // Locked, so a transfer of one of them already under way finishes first,
    // and the Workspace it moved drops out of the set rather than being
    // deleted or transferred again from its new Owner.
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
