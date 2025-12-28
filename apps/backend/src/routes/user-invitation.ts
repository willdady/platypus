import { Hono } from "hono";
import { db } from "../index.ts";
import {
  invitation as invitationTable,
  organization as organizationTable,
  workspace as workspaceTable,
  organizationMember,
  workspaceMember,
  user as userTable,
} from "../db/schema.ts";
import { eq, and, or, lt } from "drizzle-orm";
import { requireAuth } from "../middleware/authentication.ts";
import type { Variables } from "../server.ts";
import { nanoid } from "nanoid";

const userInvitation = new Hono<{ Variables: Variables }>();

/** List pending invitations for the current user */
userInvitation.get("/", requireAuth, async (c) => {
  const user = c.get("user")!;
  const now = new Date();

  const results = await db
    .select({
      id: invitationTable.id,
      email: invitationTable.email,
      organizationId: invitationTable.organizationId,
      workspaceId: invitationTable.workspaceId,
      role: invitationTable.role,
      invitedBy: invitationTable.invitedBy,
      status: invitationTable.status,
      expiresAt: invitationTable.expiresAt,
      createdAt: invitationTable.createdAt,
      organizationName: organizationTable.name,
      workspaceName: workspaceTable.name,
      invitedByName: userTable.name,
    })
    .from(invitationTable)
    .innerJoin(
      organizationTable,
      eq(invitationTable.organizationId, organizationTable.id),
    )
    .innerJoin(
      workspaceTable,
      eq(invitationTable.workspaceId, workspaceTable.id),
    )
    .innerJoin(userTable, eq(invitationTable.invitedBy, userTable.id))
    .where(
      and(
        eq(invitationTable.email, user.email),
        eq(invitationTable.status, "pending"),
        // We'll handle expiration filtering in JS or add the correct Drizzle op
      ),
    );

  // Filter out expired ones in JS for simplicity or use gt(invitationTable.expiresAt, now)
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
    return c.json(
      { message: "Invitation not found or already processed" },
      404,
    );
  }

  if (new Date(invitation[0].expiresAt) < now) {
    await db
      .update(invitationTable)
      .set({ status: "expired" })
      .where(eq(invitationTable.id, invitationId));
    return c.json({ message: "Invitation has expired" }, 410);
  }

  const invite = invitation[0];

  await db.transaction(async (tx) => {
    // 1. Ensure org membership exists
    let orgMember = await tx
      .select()
      .from(organizationMember)
      .where(
        and(
          eq(organizationMember.organizationId, invite.organizationId),
          eq(organizationMember.userId, user.id),
        ),
      )
      .limit(1);

    let orgMemberId: string;

    if (orgMember.length === 0) {
      orgMemberId = nanoid();
      await tx.insert(organizationMember).values({
        id: orgMemberId,
        organizationId: invite.organizationId,
        userId: user.id,
        role: "member",
      });
    } else {
      orgMemberId = orgMember[0].id;
    }

    // 2. Create workspace membership
    await tx.insert(workspaceMember).values({
      id: nanoid(),
      workspaceId: invite.workspaceId,
      userId: user.id,
      orgMemberId: orgMemberId,
      role: invite.role as any,
    });

    // 3. Update invitation status
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
    return c.json(
      { message: "Invitation not found or already processed" },
      404,
    );
  }

  return c.json({ message: "Invitation declined" });
});

export { userInvitation };
