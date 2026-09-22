import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";

// The auth module builds the database adapter at import time; the adapter only
// stores the handle, so a stub is enough to inspect the composed options.
vi.mock("./index.ts", () => ({ db: {} }));

const originalEnv = { ...process.env };

/**
 * better-auth's inferred options type does not surface base options alongside
 * the plugin tuple, so the tests reach for the fields they assert explicitly.
 */
type AdvancedOptions = {
  advanced?: { crossSubDomainCookies?: unknown };
};
type EmailAndPasswordOptions = {
  emailAndPassword?: { disableSignUp?: boolean };
};

const loadAuth = async () => {
  vi.resetModules();
  const { auth } = await import("./auth.ts");
  return auth;
};

const loadAdvancedOptions = async (): Promise<AdvancedOptions> =>
  (await loadAuth()).options as AdvancedOptions;

/**
 * The cookie-domain contract is asserted against the composed better-auth
 * options, not just the helper that builds the fragment, so the wiring in
 * `auth.ts` is covered end to end.
 */
describe("better-auth cookie configuration", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("omits the advanced cookie block when no domain is configured", async () => {
    process.env.BETTER_AUTH_URL = "http://localhost:4001";
    process.env.FRONTEND_URL = "http://localhost:3001";
    delete process.env.AUTH_COOKIE_DOMAIN;

    const options = await loadAdvancedOptions();

    expect(options.advanced?.crossSubDomainCookies).toBeUndefined();
  });

  it("scopes session cookies to the configured parent domain", async () => {
    process.env.BETTER_AUTH_URL = "https://api.example.com";
    process.env.FRONTEND_URL = "https://app.example.com";
    process.env.AUTH_COOKIE_DOMAIN = "example.com";

    const options = await loadAdvancedOptions();

    expect(options.advanced?.crossSubDomainCookies).toEqual({
      enabled: true,
      domain: "example.com",
    });
  });
});

/**
 * Requiring an invitation to sign up (#550, ADR-0019) is asserted first
 * against the composed options — the wiring in `auth.ts` — and then against
 * the library itself, run on an in-memory database with those same options.
 * The second half is the confirmation the ADR asks for rather than assumes:
 * `disableSignUp` closes the public sign-up endpoint and nothing else, so an
 * upgrade of the library that moved the fence would fail here. How the
 * variable's spellings parse is `sign-up.test.ts`'s, at the HTTP seam.
 */
describe("REQUIRE_INVITATION_TO_SIGN_UP", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.BETTER_AUTH_URL = "http://localhost:4001";
    process.env.FRONTEND_URL = "http://localhost:3001";
    process.env.BETTER_AUTH_SECRET = "a-test-secret-that-is-at-least-32-chars";
    delete process.env.AUTH_COOKIE_DOMAIN;
    delete process.env.REQUIRE_INVITATION_TO_SIGN_UP;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  const disableSignUp = async () =>
    ((await loadAuth()).options as EmailAndPasswordOptions).emailAndPassword
      ?.disableSignUp;

  it("leaves public sign-up open when unset", async () => {
    expect(await disableSignUp()).toBe(false);
  });

  it("closes public sign-up when set to true", async () => {
    process.env.REQUIRE_INVITATION_TO_SIGN_UP = "true";
    expect(await disableSignUp()).toBe(true);
  });

  /**
   * The composed options, run for real: the same `emailAndPassword` block and
   * plugins, with an in-memory database in place of Postgres. The tables are
   * pre-declared because the adapter reads a missing one as an error, not as
   * empty.
   */
  const runnableAuth = async () => {
    const { options } = await loadAuth();
    return betterAuth({
      ...options,
      database: memoryAdapter({
        user: [],
        session: [],
        account: [],
        verification: [],
      }),
    });
  };

  /** The `Cookie` header a browser would send back after this sign-in. */
  const sessionCookie = (response: Response): string =>
    response.headers
      .getSetCookie()
      .map((cookie) => cookie.split(";")[0])
      .join("; ");

  const INVITEE = {
    email: "invitee@example.com",
    password: "at-least-8-chars",
    name: "Robin",
  };

  describe("with sign-up closed", () => {
    beforeEach(() => {
      process.env.REQUIRE_INVITATION_TO_SIGN_UP = "true";
    });

    it("refuses the public sign-up endpoint", async () => {
      const auth = await runnableAuth();

      await expect(
        auth.api.signUpEmail({ body: INVITEE }),
      ).rejects.toMatchObject({
        statusCode: 400,
        body: { code: "EMAIL_PASSWORD_SIGN_UP_DISABLED" },
      });
    });

    // The invitation-link redemption route and the first-boot seed both mint
    // accounts this way — headerless, so no admin session is involved — and
    // the account they mint must be a normal credential account afterwards.
    it("still creates an account through the administrative API, signs it in, and lets it change its password", async () => {
      const auth = await runnableAuth();

      const created = await auth.api.createUser({ body: INVITEE });
      expect(created.user.email).toBe(INVITEE.email);

      const signedIn = await auth.api.signInEmail({
        body: { email: INVITEE.email, password: INVITEE.password },
        asResponse: true,
      });
      expect(signedIn.status).toBe(200);

      await auth.api.changePassword({
        body: {
          currentPassword: INVITEE.password,
          newPassword: "a-new-password",
        },
        headers: new Headers({ cookie: sessionCookie(signedIn) }),
      });

      const withNewPassword = await auth.api.signInEmail({
        body: { email: INVITEE.email, password: "a-new-password" },
        asResponse: true,
      });
      expect(withNewPassword.status).toBe(200);
    });

    it("still lets an administrator reset another user's password", async () => {
      const auth = await runnableAuth();
      const { user } = await auth.api.createUser({ body: INVITEE });
      const admin = {
        email: "admin@example.com",
        password: "admin-password",
        name: "Admin",
        role: "admin" as const,
      };
      await auth.api.createUser({ body: admin });
      const adminSession = await auth.api.signInEmail({
        body: { email: admin.email, password: admin.password },
        asResponse: true,
      });

      await auth.api.setUserPassword({
        body: { userId: user.id, newPassword: "reset-by-admin" },
        headers: new Headers({ cookie: sessionCookie(adminSession) }),
      });

      const signedIn = await auth.api.signInEmail({
        body: { email: INVITEE.email, password: "reset-by-admin" },
        asResponse: true,
      });
      expect(signedIn.status).toBe(200);
    });
  });

  it("leaves the public sign-up endpoint working when unset", async () => {
    const auth = await runnableAuth();

    const result = await auth.api.signUpEmail({ body: INVITEE });

    expect(result.user.email).toBe(INVITEE.email);
  });
});
