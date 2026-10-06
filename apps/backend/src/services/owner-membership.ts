import { and, eq } from "drizzle-orm";
import { organizationMember, user, workspace } from "../db/schema.ts";

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
 * The columns `ownerMayAct` reads, for a select that joins the Owner's user
 * row and left-joins `ownerMembershipJoin`.
 */
export const ownerStandingColumns = {
  membershipId: organizationMember.id,
  role: user.role,
  banned: user.banned,
  banExpires: user.banExpires,
};

/** What `ownerMayAct` reads about the Workspace Owner. */
export type OwnerStanding = {
  membershipId: string | null | undefined;
  role: string | null | undefined;
  banned: boolean | null | undefined;
  banExpires: Date | null | undefined;
};

/**
 * Whether the Workspace Owner may still act in it. A banned Owner may not —
 * super admin or not — until a ban with an expiry runs out. Otherwise a member
 * may, and so may a super admin, who needs no membership: they reach every
 * Organization without one, so a Workspace they own keeps running. The one
 * place that rule is written; every Trigger firing and A2A call reads it.
 */
export const ownerMayAct = (
  owner: OwnerStanding,
  now: Date = new Date(),
): boolean => {
  const banned =
    !!owner.banned &&
    (!owner.banExpires || owner.banExpires.getTime() > now.getTime());
  if (banned) return false;
  return !!owner.membershipId || owner.role === "admin";
};
