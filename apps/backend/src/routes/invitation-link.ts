import { Hono } from "hono";
import { db } from "../index.ts";
import {
  invitation as invitationTable,
  organization as organizationTable,
} from "../db/schema.ts";
import { eq } from "drizzle-orm";

const invitationLink = new Hono();

const INVALID_LINK_ERROR = "This invitation link is not valid";

/**
 * Resolve an invitation link token (unauthenticated, #549 / ADR-0019).
 *
 * Returns only the invited email address and the Organization's name —
 * never the inviter, the Blueprint set, or the Workspace name.
 *
 * A token that does not exist, one whose invitation is no longer pending,
 * and one that has expired all produce the exact same generic response.
 * The three causes must never be distinguishable from outside: this
 * endpoint has no session, so an attacker's only signal is what it
 * returns, and a response that varied by cause would let them enumerate
 * which unredeemed tokens are still live.
 */
invitationLink.get("/:token", async (c) => {
  const token = c.req.param("token");
  const now = new Date();

  const rows = await db
    .select({
      email: invitationTable.email,
      status: invitationTable.status,
      expiresAt: invitationTable.expiresAt,
      organizationName: organizationTable.name,
    })
    .from(invitationTable)
    .innerJoin(
      organizationTable,
      eq(invitationTable.organizationId, organizationTable.id),
    )
    .where(eq(invitationTable.token, token))
    .limit(1);

  const row = rows[0];
  const isValid =
    row !== undefined &&
    row.status === "pending" &&
    new Date(row.expiresAt) > now;

  if (!isValid) {
    return c.json({ error: INVALID_LINK_ERROR }, 404);
  }

  return c.json({ email: row.email, organizationName: row.organizationName });
});

export { invitationLink };
