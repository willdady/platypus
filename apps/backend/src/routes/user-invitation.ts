import { Hono } from "hono";
import { db } from "../index.ts";
import {
  invitation as invitationTable,
  invitationBlueprint as invitationBlueprintTable,
  organization as organizationTable,
  organizationMember,
  user as userTable,
  workspace as workspaceTable,
} from "../db/schema.ts";
import { eq, and, asc } from "drizzle-orm";
import { requireAuth } from "../middleware/authentication.ts";
import type { Variables } from "../server.ts";
import { WORKSPACE_NAME_MAX_LENGTH } from "@platypus/schemas";
import { nanoid } from "nanoid";
import { applyBlueprintsToWorkspace } from "../services/blueprint-apply.ts";

const userInvitation = new Hono<{ Variables: Variables }>();

/**
 * Possessive form of a name for the default Workspace name (ADR-0008).
 * Names ending in "s" take a bare apostrophe ("James'"), others take "'s"
 * ("Jane's").
 */
const possessive = (name: string): string =>
  /s$/i.test(name) ? `${name}'` : `${name}'s`;

/**
 * Default Workspace name for an unnamed invite: "<member name>'s Workspace",
 * clamped to the schema's max length so the provisioned workspace stays
 * editable (a long member name could otherwise overflow the 30-char limit).
 */
const defaultWorkspaceName = (name: string): string => {
  const suffix = " Workspace";
  const room = WORKSPACE_NAME_MAX_LENGTH - suffix.length;
  return `${possessive(name).slice(0, room).trimEnd()}${suffix}`;
};

/** List pending invitations for the current user */
userInvitation.get("/", requireAuth, async (c) => {
  const user = c.get("user")!;
  const now = new Date();

  const results = await db
    .select({
      id: invitationTable.id,
      email: invitationTable.email,
      organizationId: invitationTable.organizationId,
      invitedBy: invitationTable.invitedBy,
      status: invitationTable.status,
      workspaceName: invitationTable.workspaceName,
      expiresAt: invitationTable.expiresAt,
      createdAt: invitationTable.createdAt,
      organizationName: organizationTable.name,
      invitedByName: userTable.name,
    })
    .from(invitationTable)
    .innerJoin(
      organizationTable,
      eq(invitationTable.organizationId, organizationTable.id),
    )
    .innerJoin(userTable, eq(invitationTable.invitedBy, userTable.id))
    .where(
      and(
        eq(invitationTable.email, user.email),
        eq(invitationTable.status, "pending"),
      ),
    );

  const activeResults = results.filter((r) => new Date(r.expiresAt) > now);

  return c.json({ results: activeResults });
});

/** Accept an invitation */
userInvitation.post("/:invitationId/accept", requireAuth, async (c) => {
  const user = c.get("user")!;
  const invitationId = c.req.param("invitationId");
  const now = new Date();

  const invitation = await db
    .select()
    .from(invitationTable)
    .where(
      and(
        eq(invitationTable.id, invitationId),
        eq(invitationTable.email, user.email),
        eq(invitationTable.status, "pending"),
      ),
    )
    .limit(1);

  if (invitation.length === 0) {
    return c.json({ error: "Invitation not found or already processed" }, 404);
  }

  if (new Date(invitation[0].expiresAt) < now) {
    await db
      .update(invitationTable)
      .set({ status: "expired" })
      .where(eq(invitationTable.id, invitationId));
    return c.json({ error: "Invitation has expired" }, 410);
  }

  const invite = invitation[0];

  await db.transaction(async (tx) => {
    // Ensure org membership exists
    const orgMember = await tx
      .select()
      .from(organizationMember)
      .where(
        and(
          eq(organizationMember.organizationId, invite.organizationId),
          eq(organizationMember.userId, user.id),
        ),
      )
      .limit(1);

    if (orgMember.length === 0) {
      await tx.insert(organizationMember).values({
        id: nanoid(),
        organizationId: invite.organizationId,
        userId: user.id,
        role: "member",
      });
    }

    // Accepting an invitation always provisions a Workspace owned by the
    // accepting member (ADR-0008). With no Blueprint it is empty; the invite's
    // workspaceName defaults to "<member name>'s Workspace".
    const workspaceId = nanoid();
    await tx.insert(workspaceTable).values({
      id: workspaceId,
      organizationId: invite.organizationId,
      ownerId: user.id,
      name: invite.workspaceName ?? defaultWorkspaceName(user.name),
    });

    // Apply the invitation's ordered set of Blueprints (ADR-0009) to the fresh
    // Workspace, in `position` order, so it lands pre-stamped. Tier 1
    // Attachments union; Tier 2 settings resolve last-write-wins. This shares
    // the accept transaction — a partial-list failure rolls back the whole
    // accept rather than stranding a half-stamped Workspace.
    const blueprintRows = await tx
      .select({ blueprintId: invitationBlueprintTable.blueprintId })
      .from(invitationBlueprintTable)
      .where(eq(invitationBlueprintTable.invitationId, invitationId))
      .orderBy(asc(invitationBlueprintTable.position));
    await applyBlueprintsToWorkspace(
      tx,
      workspaceId,
      blueprintRows.map((r) => r.blueprintId),
    );

    // Update invitation status
    await tx
      .update(invitationTable)
      .set({ status: "accepted" })
      .where(eq(invitationTable.id, invitationId));
  });

  return c.json({ message: "Invitation accepted" });
});

/** Decline an invitation */
userInvitation.post("/:invitationId/decline", requireAuth, async (c) => {
  const user = c.get("user")!;
  const invitationId = c.req.param("invitationId");

  const result = await db
    .update(invitationTable)
    .set({ status: "declined" })
    .where(
      and(
        eq(invitationTable.id, invitationId),
        eq(invitationTable.email, user.email),
        eq(invitationTable.status, "pending"),
      ),
    )
    .returning();

  if (result.length === 0) {
    return c.json({ error: "Invitation not found or already processed" }, 404);
  }

  return c.json({ message: "Invitation declined" });
});

export { userInvitation };
