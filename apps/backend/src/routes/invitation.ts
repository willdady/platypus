import { Hono } from "hono";
import { sValidator } from "@hono/standard-validator";
import { nanoid } from "nanoid";
import { db } from "../index.ts";
import {
  invitation as invitationTable,
  workspace as workspaceTable,
} from "../db/schema.ts";
import { invitationCreateSchema } from "@platypus/schemas";
import { eq, and } from "drizzle-orm";
import { requireAuth } from "../middleware/authentication.ts";
import { requireOrgAccess } from "../middleware/authorization.ts";
import type { Variables } from "../server.ts";

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
      return c.json({ message: "You cannot invite yourself" }, 400);
    }

    // Verify workspace belongs to org
    const workspace = await db
      .select()
      .from(workspaceTable)
      .where(
        and(
          eq(workspaceTable.id, data.workspaceId),
          eq(workspaceTable.organisationId, orgId),
        ),
      )
      .limit(1);

    if (workspace.length === 0) {
      return c.json(
        { message: "Workspace not found in this organisation" },
        404,
      );
    }

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + INVITATION_EXPIRY_DAYS);

    try {
      const record = await db
        .insert(invitationTable)
        .values({
          id: nanoid(),
          email: data.email,
          organisationId: orgId,
          workspaceId: data.workspaceId,
          role: data.role,
          invitedBy: user.id,
          status: "pending",
          expiresAt,
        })
        .returning();

      return c.json(record[0], 201);
    } catch (error: any) {
      // Check for unique constraint violation (Postgres code 23505)
      // Drizzle might wrap the error or the code might be in a different property
      const isDuplicate =
        error.code === "23505" ||
        error.cause?.code === "23505" ||
        error.constraint === "unique_invitation_workspace_email" ||
        error.message?.includes("unique_invitation_workspace_email") ||
        error.detail?.includes("already exists");

      if (isDuplicate) {
        return c.json(
          {
            message:
              "A pending invitation already exists for this user and workspace",
          },
          409,
        );
      }
      console.error("Error creating invitation:", error);
      throw error;
    }
  },
);

/** List all invitations for an organisation (org admin only) */
invitation.get("/", requireAuth, requireOrgAccess(["admin"]), async (c) => {
  const orgId = c.req.param("orgId")!;

  const results = await db
    .select({
      id: invitationTable.id,
      email: invitationTable.email,
      organisationId: invitationTable.organisationId,
      workspaceId: invitationTable.workspaceId,
      role: invitationTable.role,
      invitedBy: invitationTable.invitedBy,
      status: invitationTable.status,
      expiresAt: invitationTable.expiresAt,
      createdAt: invitationTable.createdAt,
      workspaceName: workspaceTable.name,
    })
    .from(invitationTable)
    .innerJoin(
      workspaceTable,
      eq(invitationTable.workspaceId, workspaceTable.id),
    )
    .where(eq(invitationTable.organisationId, orgId));

  return c.json({ results });
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
          eq(invitationTable.organisationId, orgId),
        ),
      )
      .returning();

    if (result.length === 0) {
      return c.json({ message: "Invitation not found" }, 404);
    }

    return c.json({ message: "Invitation deleted" });
  },
);

export { invitation };
