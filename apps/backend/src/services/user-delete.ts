import { eq } from "drizzle-orm";
import { db } from "../index.ts";
import { workspace as workspaceTable } from "../db/schema.ts";
import {
  deleteWorkspaceRows,
  prepareWorkspaceCleanup,
} from "./workspace-delete.ts";

/**
 * Deletes every Workspace a User owns the way Workspace delete does, so its
 * Sandboxes and stored files go with it. Run before the User row is deleted,
 * whose cascade would otherwise take the Workspace rows and skip the rest.
 */
export const deleteOwnedWorkspaces = async (userId: string): Promise<void> => {
  const owned = await db
    .select({
      orgId: workspaceTable.organizationId,
      workspaceId: workspaceTable.id,
    })
    .from(workspaceTable)
    .where(eq(workspaceTable.ownerId, userId));
  const cleanups = await Promise.all(owned.map(prepareWorkspaceCleanup));
  await db.transaction(async (tx) => {
    for (const { workspaceId } of owned) {
      await deleteWorkspaceRows(tx, workspaceId);
    }
  });
  await Promise.all(cleanups.map((cleanUp) => cleanUp()));
};
