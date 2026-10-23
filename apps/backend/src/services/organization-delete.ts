import { eq, inArray } from "drizzle-orm";
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
 * Organization fails whenever its Provider cascade runs before the cascade
 * that takes the Agents still using it (issue #1609). Deleting Triggers, then
 * Workspaces (and their Agents), then Org Agents, leaves nothing for the
 * Organization's cascade to trip over.
 */
export const deleteOrganizationRows = async (
  tx: Tx,
  orgId: string,
): Promise<void> => {
  const workspaceIds = tx
    .select({ id: workspaceTable.id })
    .from(workspaceTable)
    .where(eq(workspaceTable.organizationId, orgId));
  await tx
    .delete(triggerTable)
    .where(inArray(triggerTable.workspaceId, workspaceIds));
  await tx
    .delete(workspaceTable)
    .where(eq(workspaceTable.organizationId, orgId));
  await tx.delete(agentTable).where(eq(agentTable.organizationId, orgId));
  await tx.delete(organizationTable).where(eq(organizationTable.id, orgId));
};
