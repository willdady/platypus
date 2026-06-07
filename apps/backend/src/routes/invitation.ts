import { Hono } from "hono";
import { sValidator } from "@hono/standard-validator";
import { nanoid } from "nanoid";
import { db } from "../index.ts";
import {
  invitation as invitationTable,
  invitationBlueprint as invitationBlueprintTable,
  blueprint as blueprintTable,
} from "../db/schema.ts";
import { invitationCreateSchema } from "@platypus/schemas";
import { eq, and, inArray, asc } from "drizzle-orm";
import { requireAuth } from "../middleware/authentication.ts";
import { requireOrgAccess } from "../middleware/authorization.ts";
import type { Variables } from "../server.ts";
import { logger } from "../logger.ts";

const invitation = new Hono<{ Variables: Variables }>();

const INVITATION_EXPIRY_DAYS = parseInt(
  process.env.INVITATION_EXPIRY_DAYS || "7",
);

/** Create a new invitation (org admin only) */
invitation.post(
  "/",
  requireAuth,
  requireOrgAccess(["admin"]),
  sValidator("json", invitationCreateSchema),
  async (c) => {
    const orgId = c.req.param("orgId")!;
    const data = c.req.valid("json");
    const user = c.get("user")!;

    if (data.email.toLowerCase() === user.email.toLowerCase()) {
      return c.json({ error: "You cannot invite yourself" }, 400);
    }

    // The invitation carries an ordered set of Blueprints (ADR-0009). Dedupe
    // while preserving order — it is a *set*, and `position` makes the order
    // first-class. Each must be a Blueprint in this organization.
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
        return c.json(
          {
            error: "One or more blueprints were not found in this organization",
            missingBlueprintIds: missing,
          },
          422,
        );
      }
    }

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + INVITATION_EXPIRY_DAYS);

    const invitationId = nanoid();
    try {
      const record = await db.transaction(async (tx) => {
        const [row] = await tx
          .insert(invitationTable)
          .values({
            id: invitationId,
            email: data.email,
            organizationId: orgId,
            invitedBy: user.id,
            status: "pending",
            workspaceName: data.workspaceName ?? null,
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
    } catch (error: any) {
      const isDuplicate =
        error.code === "23505" ||
        error.cause?.code === "23505" ||
        error.constraint === "unique_invitation_org_email" ||
        error.message?.includes("unique_invitation_org_email") ||
        error.detail?.includes("already exists");

      if (isDuplicate) {
        return c.json(
          {
            message:
              "A pending invitation already exists for this user and organization",
          },
          409,
        );
      }
      logger.error({ error }, "Error creating invitation");
      throw error;
    }
  },
);

/** List all invitations for an organization (org admin only) */
invitation.get("/", requireAuth, requireOrgAccess(["admin"]), async (c) => {
  const orgId = c.req.param("orgId")!;

  const results = await db
    .select()
    .from(invitationTable)
    .where(eq(invitationTable.organizationId, orgId));

  // Attach each invitation's ordered set of Blueprints (ADR-0009), in
  // `position` order, so the admin can see what a pending invite will provision.
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

/** Delete an invitation (org admin only) */
invitation.delete(
  "/:invitationId",
  requireAuth,
  requireOrgAccess(["admin"]),
  async (c) => {
    const invitationId = c.req.param("invitationId");
    const orgId = c.req.param("orgId")!;

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
