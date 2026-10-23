import { and, count, eq } from "drizzle-orm";
import { db, type Tx } from "../index.ts";
import { organization, organizationMember } from "../db/schema.ts";
import { ConflictError, NotFoundError, ValidationError } from "../errors.ts";

type AdminLoss = "demote" | "remove";

const SELF_MESSAGE: Record<AdminLoss, string> = {
  demote: "You cannot demote yourself from admin",
  remove: "You cannot remove yourself from the organization",
};

const LAST_ADMIN_MESSAGE: Record<AdminLoss, string> = {
  demote: "Cannot demote the last organization admin",
  remove: "Cannot remove the last organization admin",
};

type MemberChange = {
  orgId: string;
  memberId: string;
  actorUserId: string;
  change: AdminLoss;
};

/**
 * The member a demotion or removal acts on. Throws `NotFoundError` unless it
 * is a member of the Organization, and `ValidationError` when it is the
 * caller themselves.
 */
export const findChangeTarget = async (
  database: typeof db | Tx,
  { orgId, memberId, actorUserId, change }: MemberChange,
) => {
  const [target] = await database
    .select({
      id: organizationMember.id,
      userId: organizationMember.userId,
      role: organizationMember.role,
    })
    .from(organizationMember)
    .where(
      and(
        eq(organizationMember.id, memberId),
        eq(organizationMember.organizationId, orgId),
      ),
    )
    .limit(1);
  if (!target) throw new NotFoundError("Member not found");
  if (target.userId === actorUserId) {
    throw new ValidationError(SELF_MESSAGE[change]);
  }
  return target;
};

/**
 * The last-admin guard, run first in the transaction that demotes or removes
 * the member. The Organization row is the per-Organization mutex: Postgres
 * rejects `FOR UPDATE` on a `count(*)`, and one row needs no lock order. The
 * target is re-read under it, as a role read earlier may be stale. Throws as
 * {@link findChangeTarget}, and `ConflictError` when the target is the
 * Organization's last admin.
 */
export const requireAdminRemains = async (tx: Tx, change: MemberChange) => {
  await tx
    .select({ id: organization.id })
    .from(organization)
    .where(eq(organization.id, change.orgId))
    .for("update");
  const target = await findChangeTarget(tx, change);
  if (target.role === "admin") {
    const [{ value }] = await tx
      .select({ value: count() })
      .from(organizationMember)
      .where(
        and(
          eq(organizationMember.organizationId, change.orgId),
          eq(organizationMember.role, "admin"),
        ),
      );
    if (value <= 1) throw new ConflictError(LAST_ADMIN_MESSAGE[change.change]);
  }
  return target;
};

/**
 * Sets a member's Organization role. A demotion is refused as
 * {@link requireAdminRemains} refuses it, in the transaction that writes it.
 * Throws `NotFoundError` unless the member is in the Organization.
 */
export const changeMemberRole = ({
  orgId,
  memberId,
  role,
  actorUserId,
}: {
  orgId: string;
  memberId: string;
  role: "admin" | "member";
  actorUserId: string;
}) =>
  db.transaction(async (tx) => {
    if (role === "member") {
      await requireAdminRemains(tx, {
        orgId,
        memberId,
        actorUserId,
        change: "demote",
      });
    }
    const [updated] = await tx
      .update(organizationMember)
      .set({ role, updatedAt: new Date() })
      .where(
        and(
          eq(organizationMember.id, memberId),
          eq(organizationMember.organizationId, orgId),
        ),
      )
      .returning();
    if (!updated) throw new NotFoundError("Member not found");
    return updated;
  });
