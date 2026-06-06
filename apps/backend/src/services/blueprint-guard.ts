import { and, eq } from "drizzle-orm";
import { db } from "../index.ts";
import { blueprintItem as blueprintItemTable } from "../db/schema.ts";

type SharedResourceType = "mcp" | "provider" | "skill" | "agent";

/**
 * Whether a Shared resource is listed in any Blueprint (ADR-0008). Complements
 * the while-attached guard: a Shared resource cannot be deleted while anything
 * still points at it — an Attachment, or a Blueprint that would re-provision it.
 */
export const isResourceListedInBlueprint = async (
  resourceType: SharedResourceType,
  resourceId: string,
): Promise<boolean> => {
  const [row] = await db
    .select({ id: blueprintItemTable.id })
    .from(blueprintItemTable)
    .where(
      and(
        eq(blueprintItemTable.resourceType, resourceType),
        eq(blueprintItemTable.resourceId, resourceId),
      ),
    )
    .limit(1);
  return Boolean(row);
};
