import { db } from "../index.ts";
import { agent as agentTable } from "../db/schema.ts";
import { sql } from "drizzle-orm";

type ArrayRefField = "skillIds" | "subAgentIds" | "toolSetIds";

// Accepts either the db handle or a transaction so the scrub can run atomically
// with the delete that triggered it.
type Executor = Pick<typeof db, "update">;

/**
 * Remove a now-deleted Shared resource's id from every Agent that references it.
 *
 * Agent references are stored as ids in a jsonb array (`skillIds`,
 * `subAgentIds`, `toolSetIds`) with no foreign key to cascade, so deleting the
 * resource would otherwise leave dangling ids behind (ADR-0007). Those ids are
 * inert (they no longer resolve), but they are clutter; scrubbing them on delete
 * keeps Agent references honest. Uses the jsonb `-` operator to drop the
 * matching string from the array, and `@>` so only Agents that actually hold the
 * id are written.
 */
export const scrubDeletedAgentReference = async (
  executor: Executor,
  field: ArrayRefField,
  resourceId: string,
): Promise<void> => {
  const holdsId = JSON.stringify([resourceId]);
  // Explicit per-field branches keep the column references typed (no dynamic
  // key) while sharing the jsonb idiom.
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
