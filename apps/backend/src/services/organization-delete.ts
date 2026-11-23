import { eq, inArray, or } from "drizzle-orm";
import type { Tx } from "../index.ts";
import {
  agent as agentTable,
  organization as organizationTable,
  trigger as triggerTable,
  workspace as workspaceTable,
} from "../db/schema.ts";

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
