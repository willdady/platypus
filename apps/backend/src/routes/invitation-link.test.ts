import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mockAuth,
  mockSession,
  mockNoSession,
  mockCreateUser,
  mockCreateUserAlreadyExists,
  mockSignInEmail,
  resetMockDb,
  seedDb,
  type FakeDb,
  type Row,
  type Store,
} from "../test-utils.ts";
import type { FakeDbOptions, QueryRecord } from "../fake-db.ts";
import { NotFoundError } from "../errors.ts";
import app from "../server.ts";

describe("Invitation Link Routes", () => {
  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const baseUrl = "/invitation-links";
  const DAY = 24 * 60 * 60 * 1000;
  const INVALID_LINK_BODY = { error: "This invitation link is not valid" };
  const ACCOUNT_WITHOUT_INVITATION_BODY = {
    error:
      "Your account was created and you are signed in, but this invitation " +
      "was already used or has expired. Ask whoever invited you to send a " +
      "new one.",
  };

  const futureDate = () => new Date(Date.now() + 7 * DAY);
  const pastDate = () => new Date(Date.now() - DAY);

  const invitation = (over: Row = {}): Row => ({
    id: "inv-1",
    email: "user@example.com",
    organizationId: "org-1",
    status: "pending",
    token: "tok_valid",
    workspaceName: null,
    expiresAt: futureDate(),
    ...over,
  });

  const world = (
    over: Row = {},
    rows: Store = {},
    db: FakeDbOptions = {},
  ): FakeDb =>
    seedDb(
      {
        organization: [{ id: "org-1", name: "Acme" }],
        invitation: [invitation(over)],
        ...rows,
      },
      db,
    );

  const inviteeWorld = (
    over: Row = {},
    rows: Store = {},
    db: FakeDbOptions = {},
  ): FakeDb => world({ email: "invitee@example.com", ...over }, rows, db);

  const acceptRead = (query: QueryRecord) =>
    query.kind === "select" &&
    query.table === "invitation" &&
    query.lock === "update";

  const registerBody = { name: "Robin", password: "at-least-8-chars" };

  const register = (token: string, body: unknown = registerBody) =>
    app.request(`${baseUrl}/${token}/register`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    });

  const accept = (token: string) =>
    app.request(`${baseUrl}/${token}/accept`, { method: "POST" });

  describe("GET /:token", () => {
    it("resolves a valid, pending, unexpired token to the invited email and org name", async () => {
      world();

      const res = await app.request(`${baseUrl}/tok_valid`);

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        email: "user@example.com",
        organizationName: "Acme",
      });
    });

    it("404s with the generic message for a token that does not exist", async () => {
      world({ token: "tok_other" });

      const res = await app.request(`${baseUrl}/tok_unknown`);

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual(INVALID_LINK_BODY);
    });

    it("404s with the same generic message for an invitation that is no longer pending", async () => {
      world({ token: "tok_accepted", status: "accepted" });

      const res = await app.request(`${baseUrl}/tok_accepted`);

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual(INVALID_LINK_BODY);
    });

    it("404s with the same generic message for an expired invitation", async () => {
      world({ token: "tok_expired", expiresAt: pastDate() });

      const res = await app.request(`${baseUrl}/tok_expired`);

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual(INVALID_LINK_BODY);
    });

    it("responds identically for an unknown token, a non-pending invitation, and an expired one", async () => {
      seedDb({
        organization: [{ id: "org-1", name: "Acme" }],
        invitation: [
          invitation({ id: "inv-b", token: "tok_b", status: "declined" }),
          invitation({ id: "inv-c", token: "tok_c", expiresAt: pastDate() }),
        ],
      });

      const unknown = await app.request(`${baseUrl}/tok_a`);
      const notPending = await app.request(`${baseUrl}/tok_b`);
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
    it("creates the account via the admin create-user API, signs in, and accepts through the shared accept path", async () => {
      mockCreateUser({
        id: "new-user",
        email: "invitee@example.com",
        name: "Robin",
      });
      mockSignInEmail(["better-auth.session_token=tok; Path=/; HttpOnly"]);
      const fake = inviteeWorld();

      const res = await register("tok_valid");

      expect(res.status).toBe(200);
      expect(res.headers.get("set-cookie")).toContain(
        "better-auth.session_token=tok",
      );

      const provisioned = fake.tables.workspace.at(-1)!;
      expect(await res.json()).toEqual({
        message: "Invitation accepted",
        organizationId: "org-1",
        workspaceId: provisioned.id,
      });

      expect(mockAuth.api.createUser.mock.calls.at(-1)?.[0]).toMatchObject({
        body: {
          email: "invitee@example.com",
          name: "Robin",
          data: { emailVerified: true },
        },
      });
      expect(mockAuth.api.createUser.mock.calls.at(-1)?.[0]).not.toHaveProperty(
        "headers",
      );
    });

    it("404s with the generic message for an invalid token", async () => {
      inviteeWorld({ token: "tok_other" });

      const res = await register("tok_unknown");

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual(INVALID_LINK_BODY);
    });

    it("409s with a sign-in hint when an account already exists for the invited email", async () => {
      inviteeWorld();
      mockCreateUserAlreadyExists();

      const res = await register("tok_valid");

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error:
          "An account already exists for this email address. Sign in instead.",
      });
    });

    it.each([
      ["an already-redeemed", { status: "accepted", expiresAt: futureDate() }],
      ["a declined", { status: "declined", expiresAt: futureDate() }],
      ["an expired", { status: "pending", expiresAt: pastDate() }],
    ])(
      "404s with the generic message and creates no account for %s token",
      async (_label, overrides) => {
        const fake = inviteeWorld({ token: "tok_spent", ...overrides });

        const res = await register("tok_spent");

        expect(res.status).toBe(404);
        expect(await res.json()).toEqual(INVALID_LINK_BODY);
        expect(mockAuth.api.createUser).not.toHaveBeenCalled();
        expect(mockAuth.api.signInEmail).not.toHaveBeenCalled();
        expect(fake.queries.filter((q) => q.kind !== "select")).toEqual([]);
      },
    );

    it("reports the invitation as already processed when it is redeemed between resolution and accept", async () => {
      mockCreateUser({
        id: "new-user",
        email: "invitee@example.com",
        name: "Robin",
      });
      mockSignInEmail();
      inviteeWorld(
        {},
        {},
        {
          onQuery: (query) => {
            // why: the accept read runs in a transaction, so the fake clones its store before it
            if (acceptRead(query)) {
              throw new NotFoundError(
                "Invitation not found or already processed",
              );
            }
          },
        },
      );

      const res = await register("tok_valid");

      expect(res.status).toBe(410);
      expect(await res.json()).toEqual(ACCOUNT_WITHOUT_INVITATION_BODY);
    });

    it("reports the invitation as expired when it lapses between resolution and accept", async () => {
      mockCreateUser({
        id: "new-user",
        email: "invitee@example.com",
        name: "Robin",
      });
      mockSignInEmail();
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      const fake = inviteeWorld(
        {},
        {},
        {
          onQuery: (query) => {
            if (acceptRead(query)) {
              vi.setSystemTime(new Date(Date.now() + 8 * DAY));
            }
          },
        },
      );

      const res = await register("tok_valid");

      expect(res.status).toBe(410);
      expect(await res.json()).toEqual(ACCOUNT_WITHOUT_INVITATION_BODY);
      expect(fake.tables.invitation[0].status).toBe("expired");
    });

    it("rejects a password shorter than 8 characters before touching the token", async () => {
      const res = await register("tok_valid", {
        name: "Robin",
        password: "short",
      });

      expect(res.status).toBe(400);
    });
  });

  describe("POST /:token/accept", () => {
    it("accepts through the shared accept path when the session email matches the invite", async () => {
      mockSession({
        id: "u1",
        email: "invitee@example.com",
        name: "Robin",
        role: "user",
      });
      const fake = inviteeWorld(
        {},
        { user: [{ id: "u1", email: "invitee@example.com" }] },
      );

      const res = await accept("tok_valid");

      expect(res.status).toBe(200);
      expect(fake.tables.user[0].emailVerified).toBe(true);

      const provisioned = fake.tables.workspace.at(-1)!;
      expect(await res.json()).toEqual({
        message: "Invitation accepted",
        organizationId: "org-1",
        workspaceId: provisioned.id,
      });
      expect(provisioned).toMatchObject({
        organizationId: "org-1",
        ownerId: "u1",
        name: "Robin's Workspace",
      });
    });

    it("refuses with a specific reason when signed in as a different address", async () => {
      mockSession({
        id: "u2",
        email: "someone-else@example.com",
        role: "user",
      });
      const fake = inviteeWorld();

      const res = await accept("tok_valid");

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({
        error: "This invitation is for a different email address",
      });
      expect(fake.queries.filter((q) => q.kind !== "select")).toEqual([]);
    });

    it("401s when there is no session", async () => {
      mockNoSession();
      inviteeWorld();

      const res = await accept("tok_valid");

      expect(res.status).toBe(401);
    });

    it("404s with the generic message for an invalid token", async () => {
      mockSession({ id: "u1", email: "invitee@example.com", role: "user" });
      inviteeWorld({ token: "tok_other" });

      const res = await accept("tok_unknown");

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
        const fake = inviteeWorld({ token: "tok_spent", ...overrides });

        const res = await accept("tok_spent");

        expect(res.status).toBe(404);
        expect(await res.json()).toEqual(INVALID_LINK_BODY);
        expect(fake.queries.filter((q) => q.kind !== "select")).toEqual([]);
      },
    );

    it("reports the invitation as already processed when it is redeemed between resolution and accept", async () => {
      mockSession({ id: "u1", email: "invitee@example.com", role: "user" });
      inviteeWorld(
        {},
        {},
        {
          onQuery: (query) => {
            // why: the accept read runs in a transaction, so the fake clones its store before it
            if (acceptRead(query)) {
              throw new NotFoundError(
                "Invitation not found or already processed",
              );
            }
          },
        },
      );

      const res = await accept("tok_valid");

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({
        error: "Invitation not found or already processed",
      });
    });

    it("reports the invitation as expired when it lapses between resolution and accept", async () => {
      mockSession({ id: "u1", email: "invitee@example.com", role: "user" });
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      inviteeWorld(
        {},
        {},
        {
          onQuery: (query) => {
            if (acceptRead(query)) {
              vi.setSystemTime(new Date(Date.now() + 8 * DAY));
            }
          },
        },
      );

      const res = await accept("tok_valid");

      expect(res.status).toBe(410);
      expect(await res.json()).toEqual({ error: "Invitation has expired" });
    });
  });
});
