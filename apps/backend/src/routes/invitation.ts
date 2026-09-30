import { Hono } from "hono";
import { sValidator } from "@hono/standard-validator";
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
import { orgScopeOf, requireOrgAccess } from "../middleware/authorization.ts";
import type { Variables } from "../server.ts";
import { logger } from "../logger.ts";
import { ConflictError } from "../errors.ts";

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
    const { orgId } = orgScopeOf(c);
    const data = c.req.valid("json");
    const user = c.get("user")!;

    // The invitation's email is canonical in lower case. better-auth lower-cases
    // `user.email` on sign-up, and every read matches this column with an exact
    // equality predicate, so normalizing here — at the single write — is what
    // keeps a mixed-case invitation reachable by its invitee (#548).
    const normalizedEmail = data.email.toLowerCase();

    if (normalizedEmail === user.email.toLowerCase()) {
      return c.json({ error: "You cannot invite yourself" }, 400);
    }

    // An accepted invitation no longer holds the (org, email) slot (#1131), so
    // refuse a current member here — accepting would provision a second
    // Workspace for someone already in the Organization.
    const [existingMember] = await db
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
    if (existingMember) {
      throw new ConflictError(
        "This user is already a member of the organization",
      );
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
    // The redemption token (#549, ADR-0019): URL-safe, minted with the same
    // generator as the row id, whose default alphabet and 21-character
    // length are the whole defence against guessing a link.
    const token = nanoid();
    try {
      const record = await db.transaction(async (tx) => {
        // Only a pending invitation blocks a new one (#1131), but expiry is
        // lazy: a lapsed invite keeps `pending` until someone tries to accept
        // it. Settle any such row as `expired` first, so it neither holds the
        // unique slot nor lingers as a second live-looking invite.
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
      const e = error as {
        code?: string;
        constraint?: string;
        message?: string;
        detail?: string;
        cause?: { code?: string };
      };
      const isDuplicate =
        e.code === "23505" ||
        e.cause?.code === "23505" ||
        e.constraint === "unique_invitation_org_email" ||
        !!e.message?.includes("unique_invitation_org_email") ||
        !!e.detail?.includes("already exists");

      if (isDuplicate) {
        throw new ConflictError(
          "A pending invitation already exists for this user and organization",
        );
      }
      logger.error({ error }, "Error creating invitation");
      throw error;
    }
  },
);

/** List all invitations for an organization (org admin only) */
invitation.get("/", requireAuth, requireOrgAccess(["admin"]), async (c) => {
  const { orgId } = orgScopeOf(c);

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
