import { and, eq } from "drizzle-orm";
import type { MemberWorkspaceDecision } from "@platypus/schemas";
import { db } from "../index.ts";
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
  const owned = await db
    .select({ id: workspaceTable.id })
    .from(workspaceTable)
    .where(
      and(
        eq(workspaceTable.organizationId, orgId),
        eq(workspaceTable.ownerId, member.userId),
      ),
    );
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
