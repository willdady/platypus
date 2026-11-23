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
