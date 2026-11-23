import { and, eq } from "drizzle-orm";
import { organizationMember, user, workspace } from "../db/schema.ts";

export const ownerMembershipJoin = () =>
  and(
    eq(organizationMember.organizationId, workspace.organizationId),
    eq(organizationMember.userId, workspace.ownerId),
  );

export const ownerStandingColumns = {
  membershipId: organizationMember.id,
  role: user.role,
  banned: user.banned,
  banExpires: user.banExpires,
};

export type OwnerStanding = {
  membershipId: string | null | undefined;
  role: string | null | undefined;
  banned: boolean;
  banExpires: Date | null | undefined;
};

export const isBanned = (
  user: Pick<OwnerStanding, "banned" | "banExpires">,
  now: Date = new Date(),
): boolean =>
  user.banned &&
  (!user.banExpires || user.banExpires.getTime() > now.getTime());

export const ownerMayAct = (
  owner: OwnerStanding,
  now: Date = new Date(),
): boolean => {
  if (isBanned(owner, now)) return false;
  return !!owner.membershipId || owner.role === "admin";
};
