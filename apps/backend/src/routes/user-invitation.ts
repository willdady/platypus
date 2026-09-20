import { Hono } from "hono";
import { db } from "../index.ts";
import {
  invitation as invitationTable,
  organization as organizationTable,
  user as userTable,
} from "../db/schema.ts";
import { eq, and } from "drizzle-orm";
import { requireAuth } from "../middleware/authentication.ts";
import type { Variables } from "../server.ts";
import { acceptInvitationForUser } from "../services/invitation-accept.ts";
import { acceptResultResponse } from "./invitation-accept-response.ts";

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

  const result = await acceptInvitationForUser(invitationId, user);

  return acceptResultResponse(c, result);
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
