import { Hono } from "hono";
import { validate } from "../validate.ts";
import { nanoid } from "nanoid";
import { db } from "../index.ts";
import {
  invitation as invitationTable,
  invitationBlueprint as invitationBlueprintTable,
  blueprint as blueprintTable,
  organizationMember as organizationMemberTable,
  user as userTable,
} from "../db/schema.ts";
import { invitationCreateSchema } from "@platypus/schemas";
import { eq, and, inArray, asc, lte } from "drizzle-orm";
import { requireAuth } from "../middleware/authentication.ts";
import {
  orgScopeOf,
  requireOrgAccess,
  userOf,
} from "../middleware/authorization.ts";
import type { Variables } from "../server.ts";
import { ConflictError, NotFoundError, isUniqueViolation } from "../errors.ts";
import { env } from "../env.ts";

const invitation = new Hono<{ Variables: Variables }>();

invitation.post(
  "/",
  requireAuth,
  requireOrgAccess(["admin"]),
  validate("json", invitationCreateSchema),
  async (c) => {
    const { orgId } = orgScopeOf(c);
    const data = c.req.valid("json");
    const user = userOf(c);

    const normalizedEmail = data.email.toLowerCase();

    if (normalizedEmail === user.email.toLowerCase()) {
      return c.json({ error: "You cannot invite yourself" }, 400);
    }

    const blueprintIds = [...new Set(data.blueprintIds ?? [])];
    if (blueprintIds.length > 0) {
      const found = await db
        .select({ id: blueprintTable.id })
        .from(blueprintTable)
        .where(
          and(
            eq(blueprintTable.organizationId, orgId),
            inArray(blueprintTable.id, blueprintIds),
          ),
        );
      const foundSet = new Set(found.map((b) => b.id));
      const missing = blueprintIds.filter((id) => !foundSet.has(id));
      if (missing.length > 0) {
        throw new NotFoundError(
          `Blueprints not found in this organization: ${missing.join(", ")}`,
        );
      }
    }

    const existingMembership = await db
      .select({ id: organizationMemberTable.id })
      .from(organizationMemberTable)
      .innerJoin(userTable, eq(organizationMemberTable.userId, userTable.id))
      .where(
        and(
          eq(organizationMemberTable.organizationId, orgId),
          eq(userTable.email, normalizedEmail),
        ),
      )
      .limit(1);
    if (existingMembership.length > 0) {
      throw new ConflictError(
        "This user is already a member of the organization",
      );
    }

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + env().INVITATION_EXPIRY_DAYS);

    const invitationId = nanoid();
    const token = nanoid();
    try {
      const record = await db.transaction(async (tx) => {
        await tx
          .update(invitationTable)
          .set({ status: "expired" })
          .where(
            and(
              eq(invitationTable.organizationId, orgId),
              eq(invitationTable.email, normalizedEmail),
              eq(invitationTable.status, "pending"),
              lte(invitationTable.expiresAt, new Date()),
            ),
          );

        const [row] = await tx
          .insert(invitationTable)
          .values({
            id: invitationId,
            email: normalizedEmail,
            organizationId: orgId,
            invitedBy: user.id,
            status: "pending",
            workspaceName: data.workspaceName ?? null,
            token,
            expiresAt,
          })
          .returning();

        if (blueprintIds.length > 0) {
          await tx.insert(invitationBlueprintTable).values(
            blueprintIds.map((blueprintId, position) => ({
              id: nanoid(),
              invitationId,
              blueprintId,
              position,
            })),
          );
        }
        return row;
      });

      return c.json({ ...record, blueprintIds }, 201);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictError(
          "A pending invitation already exists for this user and organization",
        );
      }
      throw error;
    }
  },
);

invitation.get("/", requireAuth, requireOrgAccess(["admin"]), async (c) => {
  const { orgId } = orgScopeOf(c);

  const results = await db
    .select()
    .from(invitationTable)
    .where(eq(invitationTable.organizationId, orgId));

  const byInvitation = new Map<string, string[]>();
  const invitationIds = results.map((r) => r.id);
  if (invitationIds.length > 0) {
    const rows = await db
      .select({
        invitationId: invitationBlueprintTable.invitationId,
        blueprintId: invitationBlueprintTable.blueprintId,
      })
      .from(invitationBlueprintTable)
      .where(inArray(invitationBlueprintTable.invitationId, invitationIds))
      .orderBy(asc(invitationBlueprintTable.position));
    for (const row of rows) {
      const ids = byInvitation.get(row.invitationId) ?? [];
      ids.push(row.blueprintId);
      byInvitation.set(row.invitationId, ids);
    }
  }

  return c.json({
    results: results.map((r) => ({
      ...r,
      blueprintIds: byInvitation.get(r.id) ?? [],
    })),
  });
});

invitation.delete(
  "/:invitationId",
  requireAuth,
  requireOrgAccess(["admin"]),
  async (c) => {
    const invitationId = c.req.param("invitationId");
    const { orgId } = orgScopeOf(c);

    const result = await db
      .delete(invitationTable)
      .where(
        and(
          eq(invitationTable.id, invitationId),
          eq(invitationTable.organizationId, orgId),
        ),
      )
      .returning();

    if (result.length === 0) {
      return c.json({ error: "Invitation not found" }, 404);
    }

    return c.json({ message: "Invitation deleted" });
  },
);

export { invitation };
