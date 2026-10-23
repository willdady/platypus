import { and, eq } from "drizzle-orm";
import { db } from "../index.ts";
import { organizationMember } from "../db/schema.ts";
import { NotFoundError } from "../errors.ts";
import { requireAdminRemains } from "./last-admin-guard.ts";

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
  role: (typeof organizationMember.$inferSelect)["role"];
  actorUserId: string;
}) =>
  db.transaction(async (tx) => {
    if (role === "member") {
      await requireAdminRemains(tx, {
        orgId,
        memberId,
        actorUserId,
        loss: "demote",
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
