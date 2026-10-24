import { and, count, eq } from "drizzle-orm";
import type { db, Tx } from "../index.ts";
import { organization, organizationMember } from "../db/schema.ts";
import { ConflictError, NotFoundError, ValidationError } from "../errors.ts";

/** How a member stops being an admin: demoted, or removed outright. */
type AdminLoss = "demote" | "remove";

const SELF_MESSAGE: Record<AdminLoss, string> = {
  demote: "You cannot demote yourself from admin",
  remove: "You cannot remove yourself from the organization",
};

const LAST_ADMIN_MESSAGE: Record<AdminLoss, string> = {
  demote: "Cannot demote the last organization admin",
  remove: "Cannot remove the last organization admin",
};

/** A demotion or removal that would cost the Organization an admin. */
export type AdminLossRequest = {
  orgId: string;
  memberId: string;
  actorUserId: string;
  loss: AdminLoss;
};

/**
 * The member a demotion or removal acts on. Throws `NotFoundError` unless it
 * is a member of the Organization, and `ValidationError` when it is the
 * caller themselves.
 */
export const findLossTarget = async (
  database: typeof db | Tx,
  { orgId, memberId, actorUserId, loss }: AdminLossRequest,
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
    throw new ValidationError(SELF_MESSAGE[loss]);
  }
  return target;
};

/**
 * The last-admin guard, run first in the transaction that demotes or removes
 * the member. The Organization row is the per-Organization mutex: Postgres
 * rejects `FOR UPDATE` on a `count(*)`, and one row needs no lock order. The
 * target is re-read under it, as a role read earlier may be stale. Throws as
 * {@link findLossTarget}, and `ConflictError` when the target is the
 * Organization's last admin.
 */
export const requireAdminRemains = async (
  tx: Tx,
  request: AdminLossRequest,
) => {
  await tx
    .select({ id: organization.id })
    .from(organization)
    .where(eq(organization.id, request.orgId))
    .for("update");
  const target = await findLossTarget(tx, request);
  if (target.role === "admin") {
    const [{ value }] = await tx
      .select({ value: count() })
      .from(organizationMember)
      .where(
        and(
          eq(organizationMember.organizationId, request.orgId),
          eq(organizationMember.role, "admin"),
        ),
      );
    if (value <= 1) throw new ConflictError(LAST_ADMIN_MESSAGE[request.loss]);
  }
  return target;
};
