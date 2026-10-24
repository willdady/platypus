import { eq } from "drizzle-orm";
import { db, type Tx } from "../index.ts";
import {
  agent as agentTable,
  skill as skillTable,
  trigger as triggerTable,
  workspace as workspaceTable,
} from "../db/schema.ts";
import { prepareWorkspaceSandboxTeardown } from "../sandbox/teardown.ts";
import {
  skillStorageKeyPrefix,
  workspaceStorageKeyPrefix,
} from "../storage/keys.ts";
import { deleteStoredPrefix } from "../storage/utils.ts";
import { deleteAvatar } from "./avatar.ts";

/**
 * What deleting a Workspace leaves outside the database — its Sandboxes, its
 * stored files, its Agents' avatars and its Skills' bundled files (which sit
 * under the Organization's prefix, not the Workspace's) — read while its rows
 * still exist.
 * Run the returned cleanup once the delete commits. Neither step throws:
 * Sandbox failures are recorded in sandbox_teardown_failure (ADR-0001).
 */
export const prepareWorkspaceCleanup = async (scope: {
  orgId: string;
  workspaceId: string;
}): Promise<() => Promise<void>> => {
  const teardown = await prepareWorkspaceSandboxTeardown(scope.workspaceId);
  const agents = await db
    .select({ avatarKey: agentTable.avatarKey })
    .from(agentTable)
    .where(eq(agentTable.workspaceId, scope.workspaceId));
  const skills = await db
    .select({ id: skillTable.id })
    .from(skillTable)
    .where(eq(skillTable.workspaceId, scope.workspaceId));
  return async () => {
    await teardown();
    await deleteStoredPrefix(workspaceStorageKeyPrefix(scope));
    await Promise.all(agents.map(({ avatarKey }) => deleteAvatar(avatarKey)));
    await Promise.all(
      skills.map(({ id }) =>
        deleteStoredPrefix(
          skillStorageKeyPrefix({ orgId: scope.orgId, skillId: id }),
        ),
      ),
    );
  };
};

/**
 * Deletes a Workspace's rows, in the caller's transaction, leaves first.
 * `trigger.agent_id` and `agent.provider_id` are `ON DELETE RESTRICT`, which
 * Postgres checks as each cascade runs, so a lone delete of the Workspace
 * fails if its Providers' cascade runs before its Agents' (issues #661,
 * #1609). Deleting Triggers, then Agents, leaves nothing for the Workspace's
 * cascade to trip over.
 */
export const deleteWorkspaceRows = async (
  tx: Tx,
  workspaceId: string,
): Promise<void> => {
  await tx
    .delete(triggerTable)
    .where(eq(triggerTable.workspaceId, workspaceId));
  await tx.delete(agentTable).where(eq(agentTable.workspaceId, workspaceId));
  await tx.delete(workspaceTable).where(eq(workspaceTable.id, workspaceId));
};
