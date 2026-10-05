import { and, eq } from "drizzle-orm";
import { organizationMember, workspace } from "../db/schema.ts";

/**
 * The join condition for the Workspace Owner's membership of the Workspace's
 * Organization. Left-joined, a null membership means the Owner has left, and
 * nothing may act as them: no Trigger fires and no A2A endpoint answers
 * (GHSA-h9jr-rxwg-pgx3). Read the result through `ownerMayAct`.
 */
export const ownerMembershipJoin = () =>
  and(
    eq(organizationMember.organizationId, workspace.organizationId),
    eq(organizationMember.userId, workspace.ownerId),
  );

/**
 * Whether the Workspace Owner may still act in it. A super admin needs no
 * membership — they reach every Organization without one — so a Workspace
 * they own keeps running. The one place that rule is written.
 */
export const ownerMayAct = (
  membershipId: string | null | undefined,
  ownerRole: string | null | undefined,
): boolean => !!membershipId || ownerRole === "admin";
