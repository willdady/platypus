import type { db } from "../index.ts";
import { agent as agentTable } from "../db/schema.ts";
import { sql } from "drizzle-orm";

type ArrayRefField = "skillIds" | "subAgentIds" | "toolSetIds";

type Executor = Pick<typeof db, "update">;

export const scrubDeletedAgentReference = async (
  executor: Executor,
  field: ArrayRefField,
  resourceId: string,
): Promise<void> => {
  const holdsId = JSON.stringify([resourceId]);
  if (field === "skillIds") {
    await executor
      .update(agentTable)
      .set({
        skillIds: sql`${agentTable.skillIds} - ${resourceId}`,
        updatedAt: new Date(),
      })
      .where(sql`${agentTable.skillIds} @> ${holdsId}::jsonb`);
  } else if (field === "subAgentIds") {
    await executor
      .update(agentTable)
      .set({
        subAgentIds: sql`${agentTable.subAgentIds} - ${resourceId}`,
        updatedAt: new Date(),
      })
      .where(sql`${agentTable.subAgentIds} @> ${holdsId}::jsonb`);
  } else {
    await executor
      .update(agentTable)
      .set({
        toolSetIds: sql`${agentTable.toolSetIds} - ${resourceId}`,
        updatedAt: new Date(),
      })
      .where(sql`${agentTable.toolSetIds} @> ${holdsId}::jsonb`);
  }
};
