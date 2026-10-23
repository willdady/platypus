import { Hono } from "hono";
import { db } from "../index.ts";
import {
  invitation as invitationTable,
  organization as organizationTable,
  user as userTable,
} from "../db/schema.ts";
import { eq, and } from "drizzle-orm";
import { requireAuth } from "../middleware/authentication.ts";
import { userOf } from "../middleware/authorization.ts";
import type { Variables } from "../server.ts";
import { acceptInvitationForUser } from "../services/invitation-accept.ts";
import { acceptResultResponse } from "./invitation-accept-response.ts";
import { NotFoundError } from "../errors.ts";

const userInvitation = new Hono<{ Variables: Variables }>();

// These routes match an invitation to the caller by address alone, which
// proves nothing while sign-up is open and addresses go unconfirmed. Only an
// account whose address is verified — by redeeming an invitation link, or
// the seeded admin — may list or answer invitations here; anyone else uses
// the link, where the token is the proof.
const NOT_FOUND_ERROR = "Invitation not found or already processed";

/** List pending invitations for the current user */
userInvitation.get("/", requireAuth, async (c) => {
  const user = userOf(c);
  if (!user.emailVerified) {
    return c.json({ results: [] });
  }
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
    // Left: the inviter's account may since have been deleted.
    .leftJoin(userTable, eq(invitationTable.invitedBy, userTable.id))
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
  const user = userOf(c);
  const invitationId = c.req.param("invitationId");
  if (!user.emailVerified) {
    throw new NotFoundError(NOT_FOUND_ERROR);
  }

  const result = await acceptInvitationForUser(invitationId, user);

  return acceptResultResponse(c, result);
});

/** Decline an invitation */
userInvitation.post("/:invitationId/decline", requireAuth, async (c) => {
  const user = userOf(c);
  const invitationId = c.req.param("invitationId");
  if (!user.emailVerified) {
    return c.json({ error: NOT_FOUND_ERROR }, 404);
  }

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
    return c.json({ error: NOT_FOUND_ERROR }, 404);
  }

  return c.json({ message: "Invitation declined" });
});

export { userInvitation };
