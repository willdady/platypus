import { and, count, eq } from "drizzle-orm";
import type { db, Tx } from "../index.ts";
import { organization, organizationMember } from "../db/schema.ts";
import { ConflictError, NotFoundError, ValidationError } from "../errors.ts";
import { oneRow } from "../db/one-row.ts";

type AdminLoss = "demote" | "remove";

const SELF_MESSAGE: Record<AdminLoss, string> = {
  demote: "You cannot demote yourself from admin",
  remove: "You cannot remove yourself from the organization",
};

const LAST_ADMIN_MESSAGE: Record<AdminLoss, string> = {
  demote: "Cannot demote the last organization admin",
  remove: "Cannot remove the last organization admin",
};

export type AdminLossRequest = {
  orgId: string;
  memberId: string;
  actorUserId: string;
  loss: AdminLoss;
};

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

export const requireAdminRemains = async (
  tx: Tx,
  request: AdminLossRequest,
) => {
  // why: Organization row lock is the per-org mutex; Postgres rejects FOR UPDATE on count(*)
  await tx
    .select({ id: organization.id })
    .from(organization)
    .where(eq(organization.id, request.orgId))
    .for("update");
  const target = await findLossTarget(tx, request);
  if (target.role === "admin") {
    const { value } = oneRow(
      await tx
        .select({ value: count() })
        .from(organizationMember)
        .where(
          and(
            eq(organizationMember.organizationId, request.orgId),
            eq(organizationMember.role, "admin"),
          ),
        ),
    );
    if (value <= 1) throw new ConflictError(LAST_ADMIN_MESSAGE[request.loss]);
  }
  return target;
};
