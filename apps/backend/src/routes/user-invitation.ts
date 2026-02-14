import { Hono } from "hono";
import { db } from "../index.ts";
import {
  invitation as invitationTable,
  organization as organizationTable,
  organizationMember,
  user as userTable,
} from "../db/schema.ts";
import { eq, and } from "drizzle-orm";
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
      invitedBy: invitationTable.invitedBy,
      status: invitationTable.status,
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
    return c.json(
      { message: "Invitation not found or already processed" },
      404,
    );
  }

  return c.json({ message: "Invitation declined" });
});

export { userInvitation };
