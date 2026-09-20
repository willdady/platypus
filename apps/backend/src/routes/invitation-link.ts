import { Hono } from "hono";
import { sValidator } from "@hono/standard-validator";
import { db } from "../index.ts";
import {
  invitation as invitationTable,
  organization as organizationTable,
} from "../db/schema.ts";
import { eq } from "drizzle-orm";
import { auth } from "../auth.ts";
import { requireAuth } from "../middleware/authentication.ts";
import { acceptInvitationForUser } from "../services/invitation-accept.ts";
import { NotFoundError } from "../errors.ts";
import { acceptResultResponse } from "./invitation-accept-response.ts";
import { invitationRedemptionRegisterSchema } from "@platypus/schemas";
import type { Variables } from "../server.ts";

/**
 * Mounted at the top level as `/invitation-links`, deliberately without an
 * Organization or Workspace scoping middleware. The person opening an
 * invitation link has no session and no membership yet, so there is no scope
 * to resolve from the path or the caller; the token in the URL is the
 * credential, and each handler below checks it against the invitation row
 * before doing anything. `POST /:token/accept` is the one route that also
 * requires a session, because it acts on behalf of the signed-in user.
 */
const invitationLink = new Hono<{ Variables: Variables }>();

const INVALID_LINK_ERROR = "This invitation link is not valid";

// Reported when the invitation is redeemed or expires between resolving the
// token and accepting it, after the account has already been created and
// signed in. Naming the account is the point: the person holds one now, and
// re-opening the link would only tell them it is invalid.
const ACCOUNT_WITHOUT_INVITATION_ERROR =
  "Your account was created and you are signed in, but this invitation was " +
  "already used or has expired. Ask whoever invited you to send a new one.";

// better-auth's admin createUser rejects a duplicate email with this stable
// error code. Matching the code keeps the 409 working if the message text is
// ever reworded.
const USER_ALREADY_EXISTS_CODE = "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL";

interface ValidInvitationLink {
  id: string;
  email: string;
  organizationId: string;
  organizationName: string;
}

/**
 * Resolves a token to its invitation iff pending and unexpired — the exact
 * validity check `GET /:token` exposes publicly, shared here so the
 * redemption routes below can never treat a token as good that the
 * resolution endpoint would already call invalid.
 */
async function resolveValidInvitationByToken(
  token: string,
): Promise<ValidInvitationLink | null> {
  const now = new Date();

  const rows = await db
    .select({
      id: invitationTable.id,
      email: invitationTable.email,
      organizationId: invitationTable.organizationId,
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

  return isValid
    ? {
        id: row.id,
        email: row.email,
        organizationId: row.organizationId,
        organizationName: row.organizationName,
      }
    : null;
}

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
  const resolved = await resolveValidInvitationByToken(c.req.param("token"));

  if (!resolved) {
    return c.json({ error: INVALID_LINK_ERROR }, 404);
  }

  return c.json({
    email: resolved.email,
    organizationName: resolved.organizationName,
  });
});

/**
 * Redeem an invitation link by creating a fresh account (unauthenticated,
 * #549 / ADR-0019) — the "no account" arrival state on `/invite/[token]`.
 *
 * The invited email comes only from the resolved token, never from the
 * request body, so the account this mints is always for the address the
 * invitation names — matching the frontend's non-editable email field.
 *
 * Account creation goes through the auth library's administrative
 * create-user API (`auth.api.createUser`), called in-process with no
 * `headers`/`request` in the call — better-auth's admin plugin only demands
 * an authenticated admin session when those are present (it treats a
 * headerless call as a trusted internal one), so this route needs no admin
 * session of its own and never goes through — or is limited by — whatever
 * the public `/sign-up` endpoint happens to allow. Acceptance itself calls
 * `acceptInvitationForUser`, the same function the authenticated accept
 * routes use — not a second provisioning fork.
 */
invitationLink.post(
  "/:token/register",
  sValidator("json", invitationRedemptionRegisterSchema),
  async (c) => {
    const token = c.req.param("token");
    const { name, password } = c.req.valid("json");

    const resolved = await resolveValidInvitationByToken(token);
    if (!resolved) {
      return c.json({ error: INVALID_LINK_ERROR }, 404);
    }

    let userId: string;
    try {
      const created = await auth.api.createUser({
        body: { email: resolved.email, password, name },
      });
      userId = created.user.id;
    } catch (error) {
      const e = error as { status?: string; body?: { code?: string } };
      if (
        e.status === "BAD_REQUEST" &&
        e.body?.code === USER_ALREADY_EXISTS_CODE
      ) {
        return c.json(
          {
            error:
              "An account already exists for this email address. Sign in instead.",
          },
          409,
        );
      }
      throw error;
    }

    const signIn = await auth.api.signInEmail({
      body: { email: resolved.email, password },
      asResponse: true,
    });
    for (const cookie of signIn.headers.getSetCookie()) {
      c.header("set-cookie", cookie, { append: true });
    }

    // The token was valid moments ago (`resolved` above), so a failure here
    // means it was redeemed or expired in the gap. The account this route
    // just created is real and signed in either way, and no retry of the
    // link can recover it — so say so plainly instead of letting the bare
    // not-found/expired response imply nothing happened.
    let result;
    try {
      result = await acceptInvitationForUser(resolved.id, {
        id: userId,
        name,
        email: resolved.email,
      });
    } catch (error) {
      if (error instanceof NotFoundError) {
        return c.json({ error: ACCOUNT_WITHOUT_INVITATION_ERROR }, 410);
      }
      throw error;
    }

    if (result.outcome === "expired") {
      return c.json({ error: ACCOUNT_WITHOUT_INVITATION_ERROR }, 410);
    }

    return acceptResultResponse(c, result);
  },
);

/**
 * Redeem an invitation link while already signed in (#549 / ADR-0019) — the
 * other two arrival states on `/invite/[token]`: a session whose email
 * matches the invite accepts through the same shared accept path; a session
 * with a different email is refused with a specific reason. An
 * authenticated caller, unlike the anonymous `GET` above, does not gain
 * anything from that specificity that their own session doesn't already
 * tell them.
 */
invitationLink.post("/:token/accept", requireAuth, async (c) => {
  const token = c.req.param("token");
  const user = c.get("user")!;

  const resolved = await resolveValidInvitationByToken(token);
  if (!resolved) {
    return c.json({ error: INVALID_LINK_ERROR }, 404);
  }

  if (resolved.email !== user.email) {
    return c.json(
      { error: "This invitation is for a different email address" },
      403,
    );
  }

  const result = await acceptInvitationForUser(resolved.id, user);

  return acceptResultResponse(c, result);
});

export { invitationLink };
