import { eq, inArray, or } from "drizzle-orm";
import type { Tx } from "../index.ts";
import {
  agent as agentTable,
  organization as organizationTable,
  trigger as triggerTable,
  workspace as workspaceTable,
} from "../db/schema.ts";

/**
 * Deletes an Organization's rows, in the caller's transaction, leaves first.
 * `agent.provider_id` and `trigger.agent_id` are `ON DELETE RESTRICT`, and
 * Postgres checks each against the end of the cascade that deletes the
 * referenced row, not the end of the whole delete. So a single delete of the
 * Organization fails whenever a Provider cascade (the Organization's, or a
 * Workspace's) runs before the cascade that takes the Agents still using it
 * (issues #1609, #1610). Deleting Triggers, then every Agent, leaves nothing
 * for the Organization's cascade to trip over.
 */
export const deleteOrganizationRows = async (
  tx: Tx,
  orgId: string,
): Promise<void> => {
  const workspaceIdsQuery = tx
    .select({ id: workspaceTable.id })
    .from(workspaceTable)
    .where(eq(workspaceTable.organizationId, orgId));
  await tx
    .delete(triggerTable)
    .where(inArray(triggerTable.workspaceId, workspaceIdsQuery));
  await tx
    .delete(agentTable)
    .where(
      or(
        eq(agentTable.organizationId, orgId),
        inArray(agentTable.workspaceId, workspaceIdsQuery),
      ),
    );
  await tx.delete(organizationTable).where(eq(organizationTable.id, orgId));
};
