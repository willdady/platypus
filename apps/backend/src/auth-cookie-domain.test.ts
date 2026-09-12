import { afterEach, describe, expect, it } from "vitest";
import {
  checkAuthTopology,
  crossSubdomainCookieConfig,
  resolveAuthCookieDomain,
} from "./auth-cookie-domain.ts";

/**
 * Narrows a result to its failure branch, so each test can assert on the
 * message without repeating the `valid` guard.
 */
const expectInvalid = (result: ReturnType<typeof checkAuthTopology>) => {
  expect(result.valid).toBe(false);
  if (result.valid) throw new Error("expected the topology to be rejected");
  return result.message;
};

/**
 * The backend and frontend host relationship decides whether server-rendered
 * requests can be authenticated at all. The pure check is covered row by row
 * against the table in the issue; the env-reading wrapper is covered separately
 * so the fatal path is exercised without booting a server.
 */
describe("checkAuthTopology", () => {
  it("starts when both origins share a host and no cookie domain is set", () => {
    // The default compose topology: same host, different ports. Cookies ignore
    // ports, so nothing more is needed.
    const result = checkAuthTopology(
      "http://localhost:4000",
      "http://localhost:3001",
      undefined,
    );

    expect(result).toEqual({ valid: true, cookieDomain: undefined });
  });

  it("starts when both origins share a host and the cookie domain is its parent", () => {
    const result = checkAuthTopology(
      "https://api.example.com",
      "https://api.example.com",
      "example.com",
    );

    expect(result).toEqual({ valid: true, cookieDomain: "example.com" });
  });

  it("refuses a cookie domain that is not a parent of the shared host", () => {
    const result = checkAuthTopology(
      "https://app.example.com",
      "https://app.example.com",
      "example.net",
    );

    const message = expectInvalid(result);
    expect(message).toContain("AUTH_COOKIE_DOMAIN");
    expect(message).toContain("app.example.com");
  });

  it("refuses two different hosts with no cookie domain", () => {
    const result = checkAuthTopology(
      "https://api.example.com",
      "https://app.example.com",
      undefined,
    );

    const message = expectInvalid(result);
    expect(message).toContain("api.example.com");
    expect(message).toContain("app.example.com");
    expect(message).toContain("AUTH_COOKIE_DOMAIN");
  });

  it("starts when the cookie domain is a parent of both differing hosts", () => {
    const result = checkAuthTopology(
      "https://api.example.com",
      "https://app.example.com",
      "example.com",
    );

    expect(result).toEqual({ valid: true, cookieDomain: "example.com" });
  });

  it("refuses a cookie domain that is a parent of only one host", () => {
    const result = checkAuthTopology(
      "https://api.example.com",
      "https://app.example.com",
      "api.example.com",
    );

    const message = expectInvalid(result);
    expect(message).toContain("api.example.com");
    expect(message).toContain("app.example.com");
    expect(message).toContain("AUTH_COOKIE_DOMAIN");
  });

  it("matches hosts and domains case-insensitively", () => {
    const result = checkAuthTopology(
      "HTTPS://API.EXAMPLE.COM",
      "https://App.Example.Com",
      "EXAMPLE.COM",
    );

    expect(result).toEqual({ valid: true, cookieDomain: "example.com" });
  });

  it("ignores the port when comparing hosts", () => {
    const result = checkAuthTopology(
      "http://example.com:4001",
      "http://example.com:3001",
      "example.com",
    );

    expect(result).toEqual({ valid: true, cookieDomain: "example.com" });
  });

  it("rejects a leading-dot cookie domain", () => {
    // The variable takes a bare domain. Accepting the legacy dotted form would
    // leave two spellings of the same value in circulation.
    const result = checkAuthTopology(
      "https://api.example.com",
      "https://app.example.com",
      ".example.com",
    );

    const message = expectInvalid(result);
    expect(message).toContain("AUTH_COOKIE_DOMAIN");
    expect(message).toContain("leading dot");
  });

  it("rejects a cookie domain given as a URL, saying so", () => {
    // Without this the value falls through to the suffix check and is refused
    // as "not a parent domain of both", which sends the Operator hunting the
    // wrong rule.
    const result = checkAuthTopology(
      "https://api.example.com",
      "https://app.example.com",
      "https://example.com",
    );

    const message = expectInvalid(result);
    expect(message).toContain("AUTH_COOKIE_DOMAIN");
    expect(message).toContain("URL, not a bare domain");
  });

  it("rejects a cookie domain carrying a path", () => {
    const result = checkAuthTopology(
      "https://api.example.com",
      "https://app.example.com",
      "example.com/app",
    );

    expect(expectInvalid(result)).toContain("URL, not a bare domain");
  });

  it("rejects a single-label cookie domain", () => {
    const result = checkAuthTopology(
      "http://localhost:4001",
      "http://localhost:3001",
      "localhost",
    );

    const message = expectInvalid(result);
    expect(message).toContain("AUTH_COOKIE_DOMAIN");
    expect(message).toContain("single-label");
  });

  it("rejects an IP-address cookie domain", () => {
    const result = checkAuthTopology(
      "http://10.0.0.5:4001",
      "http://10.0.0.5:3001",
      "10.0.0.5",
    );

    const message = expectInvalid(result);
    expect(message).toContain("AUTH_COOKIE_DOMAIN");
    expect(message).toContain("IP address");
  });

  it("rejects a cookie domain equal to a hostname that is an IP address", () => {
    const result = checkAuthTopology(
      "http://127.0.0.1:4001",
      "http://127.0.0.1:3001",
      "127.0.0.1",
    );

    expect(expectInvalid(result)).toContain("IP address");
  });

  it("rejects an IPv6-address cookie domain", () => {
    const result = checkAuthTopology(
      "http://[::1]:4001",
      "http://[::1]:3001",
      "::1",
    );

    expect(expectInvalid(result)).toContain("IP address");
  });

  it("refuses a backend URL it cannot read a hostname from", () => {
    // Neither hostname can be compared, so the topology is unjudgeable and the
    // same refusal applies. The message names only the variable at fault.
    const result = checkAuthTopology(
      "api.example.com",
      "https://app.example.com",
      "example.com",
    );

    const message = expectInvalid(result);
    expect(message).toContain("BETTER_AUTH_URL");
    expect(message).toContain("api.example.com");
    expect(message).not.toContain("FRONTEND_URL");
  });

  it("refuses a frontend URL it cannot read a hostname from", () => {
    const result = checkAuthTopology(
      "https://api.example.com",
      "not a url",
      undefined,
    );

    const message = expectInvalid(result);
    expect(message).toContain("FRONTEND_URL");
    expect(message).not.toContain("BETTER_AUTH_URL");
  });

  it("names both variables when neither URL is readable", () => {
    const result = checkAuthTopology("api", "app", undefined);

    const message = expectInvalid(result);
    expect(message).toContain("BETTER_AUTH_URL");
    expect(message).toContain("FRONTEND_URL");
  });
});

describe("crossSubdomainCookieConfig", () => {
  it("adds nothing when no cookie domain is set", () => {
    // The single-origin deployment must see exactly today's configuration.
    const config = crossSubdomainCookieConfig(undefined);

    expect(config).toEqual({});
    expect("advanced" in config).toBe(false);
  });

  it("issues session cookies for the shared parent domain when set", () => {
    const config = crossSubdomainCookieConfig("example.com");

    expect(config).toEqual({
      advanced: {
        crossSubDomainCookies: { enabled: true, domain: "example.com" },
      },
    });
  });
});

describe("resolveAuthCookieDomain", () => {
  afterEach(() => {
    delete process.env.BETTER_AUTH_URL;
    delete process.env.FRONTEND_URL;
    delete process.env.AUTH_COOKIE_DOMAIN;
  });

  it("returns undefined for the default same-host configuration", () => {
    process.env.BETTER_AUTH_URL = "http://localhost:4001";
    process.env.FRONTEND_URL = "http://localhost:3001";

    expect(resolveAuthCookieDomain()).toBeUndefined();
  });

  it("returns the configured parent domain", () => {
    process.env.BETTER_AUTH_URL = "https://api.example.com";
    process.env.FRONTEND_URL = "https://app.example.com";
    process.env.AUTH_COOKIE_DOMAIN = "example.com";

    expect(resolveAuthCookieDomain()).toBe("example.com");
  });

  it("throws before startup on a topology that cannot authenticate SSR requests", () => {
    process.env.BETTER_AUTH_URL = "https://api.example.com";
    process.env.FRONTEND_URL = "https://app.other.com";
    process.env.AUTH_COOKIE_DOMAIN = "example.com";

    expect(() => resolveAuthCookieDomain()).toThrowError(/AUTH_COOKIE_DOMAIN/);
    expect(() => resolveAuthCookieDomain()).toThrowError(/api\.example\.com/);
    expect(() => resolveAuthCookieDomain()).toThrowError(/app\.other\.com/);
  });
});
