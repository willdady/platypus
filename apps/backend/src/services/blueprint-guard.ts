import { and, eq } from "drizzle-orm";
import { db, type Executor } from "../index.ts";
import {
  blueprintItem as blueprintItemTable,
  invitationBlueprint as invitationBlueprintTable,
  invitation as invitationTable,
} from "../db/schema.ts";
import type { AttachmentResourceType } from "@platypus/schemas";

export const isResourceListedInBlueprint = async (
  resourceType: AttachmentResourceType,
  resourceId: string,
  exec: Executor = db,
): Promise<boolean> => {
  const [row] = await exec
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

export const isBlueprintReferencedByLiveInvitation = async (
  blueprintId: string,
): Promise<boolean> => {
  const rows = await db
    .select({ expiresAt: invitationTable.expiresAt })
    .from(invitationBlueprintTable)
    .innerJoin(
      invitationTable,
      eq(invitationBlueprintTable.invitationId, invitationTable.id),
    )
    .where(
      and(
        eq(invitationBlueprintTable.blueprintId, blueprintId),
        eq(invitationTable.status, "pending"),
      ),
    );
  const now = new Date();
  return rows.some((r) => new Date(r.expiresAt) > now);
};
