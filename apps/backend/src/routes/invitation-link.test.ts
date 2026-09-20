import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  mockAuth,
  mockDb,
  mockSession,
  mockNoSession,
  mockCreateUser,
  mockCreateUserAlreadyExists,
  mockSignInEmail,
  resetMockDb,
} from "../test-utils.ts";
import app from "../server.ts";

describe("Invitation Link Routes", () => {
  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
    mockDb.where.mockReturnValue(mockDb);
    mockDb.innerJoin.mockReturnValue(mockDb);
  });

  const baseUrl = "/invitation-links";
  const INVALID_LINK_BODY = { error: "This invitation link is not valid" };
  // The account exists and is signed in; only the invitation is gone. The
  // register route says so rather than reporting a bare not-found/expired.
  const ACCOUNT_WITHOUT_INVITATION_BODY = {
    error:
      "Your account was created and you are signed in, but this invitation " +
      "was already used or has expired. Ask whoever invited you to send a " +
      "new one.",
  };

  const futureDate = () => {
    const d = new Date();
    d.setDate(d.getDate() + 7);
    return d.toISOString();
  };

  const pastDate = () => {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return d.toISOString();
  };

  describe("GET /:token", () => {
    it("resolves a valid, pending, unexpired token to the invited email and org name", async () => {
      mockDb.limit.mockResolvedValueOnce([
        {
          email: "user@example.com",
          status: "pending",
          expiresAt: futureDate(),
          organizationName: "Acme",
        },
      ]);

      const res = await app.request(`${baseUrl}/tok_valid`);

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        email: "user@example.com",
        organizationName: "Acme",
      });
    });

    it("404s with the generic message for a token that does not exist", async () => {
      mockDb.limit.mockResolvedValueOnce([]);

      const res = await app.request(`${baseUrl}/tok_unknown`);

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual(INVALID_LINK_BODY);
    });

    it("404s with the same generic message for an invitation that is no longer pending", async () => {
      mockDb.limit.mockResolvedValueOnce([
        {
          email: "user@example.com",
          status: "accepted",
          expiresAt: futureDate(),
          organizationName: "Acme",
        },
      ]);

      const res = await app.request(`${baseUrl}/tok_accepted`);

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual(INVALID_LINK_BODY);
    });

    it("404s with the same generic message for an expired invitation", async () => {
      mockDb.limit.mockResolvedValueOnce([
        {
          email: "user@example.com",
          status: "pending",
          expiresAt: pastDate(),
          organizationName: "Acme",
        },
      ]);

      const res = await app.request(`${baseUrl}/tok_expired`);

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual(INVALID_LINK_BODY);
    });

    // The oracle-safety property itself: an unknown token, a non-pending
    // invitation, and an expired one must be byte-identical to a caller —
    // otherwise the endpoint lets an attacker enumerate which unredeemed
    // tokens are still live.
    it("responds identically for an unknown token, a non-pending invitation, and an expired one", async () => {
      mockDb.limit.mockResolvedValueOnce([]);
      const unknown = await app.request(`${baseUrl}/tok_a`);

      mockDb.limit.mockResolvedValueOnce([
        {
          email: "user@example.com",
          status: "declined",
          expiresAt: futureDate(),
          organizationName: "Acme",
        },
      ]);
      const notPending = await app.request(`${baseUrl}/tok_b`);

      mockDb.limit.mockResolvedValueOnce([
        {
          email: "user@example.com",
          status: "pending",
          expiresAt: pastDate(),
          organizationName: "Acme",
        },
      ]);
      const expired = await app.request(`${baseUrl}/tok_c`);

      const unknownBody = (await unknown.json()) as { error: string };
      const notPendingBody = (await notPending.json()) as { error: string };
      const expiredBody = (await expired.json()) as { error: string };

      expect(unknown.status).toBe(404);
      expect(notPending.status).toBe(404);
      expect(expired.status).toBe(404);
      expect(unknownBody).toEqual(INVALID_LINK_BODY);
      expect(notPendingBody).toEqual(INVALID_LINK_BODY);
      expect(expiredBody).toEqual(INVALID_LINK_BODY);
    });
  });

  describe("POST /:token/register", () => {
    const validInvitationRow = {
      id: "inv-1",
      email: "invitee@example.com",
      organizationId: "org-1",
      status: "pending",
      expiresAt: futureDate(),
      organizationName: "Acme",
    };

    it("creates the account via the admin create-user API, signs in, and accepts through the shared accept path", async () => {
      mockDb.limit.mockResolvedValueOnce([validInvitationRow]); // resolveValidInvitationByToken
      mockCreateUser({
        id: "new-user",
        email: "invitee@example.com",
        name: "Robin",
      });
      mockSignInEmail(["better-auth.session_token=tok; Path=/; HttpOnly"]);
      mockDb.limit.mockResolvedValueOnce([
        { ...validInvitationRow, workspaceName: null },
      ]); // acceptInvitationForUser: fetch invitation
      mockDb.limit.mockResolvedValueOnce([]); // acceptInvitationForUser: org membership (none)
      mockDb.orderBy.mockResolvedValueOnce([]); // acceptInvitationForUser: no blueprints

      const res = await app.request(`${baseUrl}/tok_valid/register`, {
        method: "POST",
        body: JSON.stringify({ name: "Robin", password: "at-least-8-chars" }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(200);
      expect(res.headers.get("set-cookie")).toContain(
        "better-auth.session_token=tok",
      );

      // The response names the Organization and the Workspace this accept
      // provisioned, so the client can land the new member there.
      const provisioned = mockDb.values.mock.calls
        .map((c) => c[0] as Record<string, unknown>)
        .find((v) => v?.name);
      expect(await res.json()).toEqual({
        message: "Invitation accepted",
        organizationId: "org-1",
        workspaceId: provisioned!.id,
      });

      // The email that reaches auth.api.createUser is the token's, never
      // anything the client could have supplied in the body.
      expect(mockAuth.api.createUser.mock.calls.at(-1)?.[0]).toMatchObject({
        body: { email: "invitee@example.com", name: "Robin" },
      });
    });

    it("404s with the generic message for an invalid token", async () => {
      mockDb.limit.mockResolvedValueOnce([]); // resolveValidInvitationByToken: no row

      const res = await app.request(`${baseUrl}/tok_unknown/register`, {
        method: "POST",
        body: JSON.stringify({ name: "Robin", password: "at-least-8-chars" }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual(INVALID_LINK_BODY);
    });

    it("409s with a sign-in hint when an account already exists for the invited email", async () => {
      mockDb.limit.mockResolvedValueOnce([validInvitationRow]);
      mockCreateUserAlreadyExists();

      const res = await app.request(`${baseUrl}/tok_valid/register`, {
        method: "POST",
        body: JSON.stringify({ name: "Robin", password: "at-least-8-chars" }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error:
          "An account already exists for this email address. Sign in instead.",
      });
    });

    // The redemption path must refuse a spent or lapsed token *before* it
    // mints an account -- otherwise a dead link still creates users.
    it.each([
      ["an already-redeemed", { status: "accepted", expiresAt: futureDate() }],
      ["a declined", { status: "declined", expiresAt: futureDate() }],
      ["an expired", { status: "pending", expiresAt: pastDate() }],
    ])(
      "404s with the generic message and creates no account for %s token",
      async (_label, overrides) => {
        mockDb.limit.mockResolvedValueOnce([
          { ...validInvitationRow, ...overrides },
        ]);

        const res = await app.request(`${baseUrl}/tok_spent/register`, {
          method: "POST",
          body: JSON.stringify({ name: "Robin", password: "at-least-8-chars" }),
          headers: { "Content-Type": "application/json" },
        });

        expect(res.status).toBe(404);
        expect(await res.json()).toEqual(INVALID_LINK_BODY);
        expect(mockAuth.api.createUser).not.toHaveBeenCalled();
        expect(mockAuth.api.signInEmail).not.toHaveBeenCalled();
      },
    );

    // The token resolved, the account was made, and only then did the
    // invitation turn out to be gone. The account is real either way, so the
    // caller gets the invitation-specific reason rather than the generic one.
    it("reports the invitation as already processed when it is redeemed between resolution and accept", async () => {
      mockDb.limit.mockResolvedValueOnce([validInvitationRow]); // resolveValidInvitationByToken
      mockCreateUser({
        id: "new-user",
        email: "invitee@example.com",
        name: "Robin",
      });
      mockSignInEmail();
      mockDb.limit.mockResolvedValueOnce([]); // acceptInvitationForUser: no longer pending

      const res = await app.request(`${baseUrl}/tok_valid/register`, {
        method: "POST",
        body: JSON.stringify({ name: "Robin", password: "at-least-8-chars" }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(410);
      expect(await res.json()).toEqual(ACCOUNT_WITHOUT_INVITATION_BODY);
    });

    it("reports the invitation as expired when it lapses between resolution and accept", async () => {
      mockDb.limit.mockResolvedValueOnce([validInvitationRow]); // resolveValidInvitationByToken
      mockCreateUser({
        id: "new-user",
        email: "invitee@example.com",
        name: "Robin",
      });
      mockSignInEmail();
      mockDb.limit.mockResolvedValueOnce([
        { ...validInvitationRow, expiresAt: pastDate() },
      ]); // acceptInvitationForUser: fetch invitation, now past its expiry

      const res = await app.request(`${baseUrl}/tok_valid/register`, {
        method: "POST",
        body: JSON.stringify({ name: "Robin", password: "at-least-8-chars" }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(410);
      expect(await res.json()).toEqual(ACCOUNT_WITHOUT_INVITATION_BODY);
    });

    it("rejects a password shorter than 8 characters before touching the token", async () => {
      const res = await app.request(`${baseUrl}/tok_valid/register`, {
        method: "POST",
        body: JSON.stringify({ name: "Robin", password: "short" }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(400);
    });
  });

  describe("POST /:token/accept", () => {
    const validInvitationRow = {
      id: "inv-1",
      email: "invitee@example.com",
      organizationId: "org-1",
      status: "pending",
      expiresAt: futureDate(),
      organizationName: "Acme",
    };

    it("accepts through the shared accept path when the session email matches the invite", async () => {
      mockSession({
        id: "u1",
        email: "invitee@example.com",
        name: "Robin",
        role: "user",
      });
      mockDb.limit.mockResolvedValueOnce([validInvitationRow]); // resolveValidInvitationByToken
      mockDb.limit.mockResolvedValueOnce([
        { ...validInvitationRow, workspaceName: null },
      ]); // acceptInvitationForUser: fetch invitation
      mockDb.limit.mockResolvedValueOnce([]); // org membership (none)
      mockDb.orderBy.mockResolvedValueOnce([]); // no blueprints

      const res = await app.request(`${baseUrl}/tok_valid/accept`, {
        method: "POST",
      });

      expect(res.status).toBe(200);

      const provisioned = mockDb.values.mock.calls
        .map((c) => c[0] as Record<string, unknown>)
        .find((v) => v?.name);
      expect(await res.json()).toEqual({
        message: "Invitation accepted",
        organizationId: "org-1",
        workspaceId: provisioned!.id,
      });
    });

    it("refuses with a specific reason when signed in as a different address", async () => {
      mockSession({
        id: "u2",
        email: "someone-else@example.com",
        role: "user",
      });
      mockDb.limit.mockResolvedValueOnce([validInvitationRow]);

      const res = await app.request(`${baseUrl}/tok_valid/accept`, {
        method: "POST",
      });

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({
        error: "This invitation is for a different email address",
      });
    });

    it("401s when there is no session", async () => {
      mockNoSession();

      const res = await app.request(`${baseUrl}/tok_valid/accept`, {
        method: "POST",
      });

      expect(res.status).toBe(401);
    });

    it("404s with the generic message for an invalid token", async () => {
      mockSession({ id: "u1", email: "invitee@example.com", role: "user" });
      mockDb.limit.mockResolvedValueOnce([]);

      const res = await app.request(`${baseUrl}/tok_unknown/accept`, {
        method: "POST",
      });

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual(INVALID_LINK_BODY);
    });

    it.each([
      ["an already-redeemed", { status: "accepted", expiresAt: futureDate() }],
      ["a declined", { status: "declined", expiresAt: futureDate() }],
      ["an expired", { status: "pending", expiresAt: pastDate() }],
    ])(
      "404s with the generic message and provisions nothing for %s token",
      async (_label, overrides) => {
        mockSession({ id: "u1", email: "invitee@example.com", role: "user" });
        mockDb.limit.mockResolvedValueOnce([
          { ...validInvitationRow, ...overrides },
        ]);

        const res = await app.request(`${baseUrl}/tok_spent/accept`, {
          method: "POST",
        });

        expect(res.status).toBe(404);
        expect(await res.json()).toEqual(INVALID_LINK_BODY);
        expect(mockDb.transaction).not.toHaveBeenCalled();
      },
    );

    it("reports the invitation as already processed when it is redeemed between resolution and accept", async () => {
      mockSession({ id: "u1", email: "invitee@example.com", role: "user" });
      mockDb.limit.mockResolvedValueOnce([validInvitationRow]); // resolveValidInvitationByToken
      mockDb.limit.mockResolvedValueOnce([]); // acceptInvitationForUser: no longer pending

      const res = await app.request(`${baseUrl}/tok_valid/accept`, {
        method: "POST",
      });

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({
        error: "Invitation not found or already processed",
      });
    });

    it("reports the invitation as expired when it lapses between resolution and accept", async () => {
      mockSession({ id: "u1", email: "invitee@example.com", role: "user" });
      mockDb.limit.mockResolvedValueOnce([validInvitationRow]); // resolveValidInvitationByToken
      mockDb.limit.mockResolvedValueOnce([
        { ...validInvitationRow, expiresAt: pastDate() },
      ]); // acceptInvitationForUser: fetch invitation, now past its expiry

      const res = await app.request(`${baseUrl}/tok_valid/accept`, {
        method: "POST",
      });

      expect(res.status).toBe(410);
      expect(await res.json()).toEqual({ error: "Invitation has expired" });
    });
  });
});
