import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The auth module builds the database adapter at import time; the adapter only
// stores the handle, so a stub is enough to inspect the composed options.
vi.mock("./index.ts", () => ({ db: {} }));

const originalEnv = { ...process.env };

/**
 * better-auth's inferred options type does not surface base options alongside
 * the plugin tuple, so the test reaches for the field it asserts explicitly.
 */
type AdvancedOptions = {
  advanced?: { crossSubDomainCookies?: unknown };
};

const loadAdvancedOptions = async (): Promise<AdvancedOptions> => {
  vi.resetModules();
  const { auth } = await import("./auth.ts");
  return auth.options as AdvancedOptions;
};

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
