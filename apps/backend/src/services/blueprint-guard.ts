import { and, eq } from "drizzle-orm";
import { db } from "../index.ts";
import {
  blueprintItem as blueprintItemTable,
  invitationBlueprint as invitationBlueprintTable,
  invitation as invitationTable,
} from "../db/schema.ts";

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

/**
 * Whether a Blueprint is referenced by a **live pending** invitation (ADR-0009)
 * — the literal generalization of "nothing still pointed-at is deletable"
 * (chain: Shared resource ← Blueprint ← pending invitation). A Blueprint cannot
 * be deleted while such an invitation exists, or accept-time provisioning would
 * dereference a missing Blueprint.
 *
 * The predicate is `status = 'pending' AND expiresAt > now()`. Invitation expiry
 * is lazy with write-back (a row stays `pending` until read, then flips to
 * `expired`), so `status` alone is not trustworthy — we filter `expiresAt` in
 * app code, mirroring the invitation list endpoint, rather than trust the flag.
 */
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
