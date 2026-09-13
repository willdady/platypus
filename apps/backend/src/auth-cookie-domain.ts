/**
 * Whether the configured backend and frontend origins can authenticate
 * server-side requests at all.
 *
 * During server-side rendering the frontend calls the backend over the internal
 * URL and forwards the browser's `cookie` header. That header only carries the
 * better-auth session cookie when both origins resolve to the same host (cookies
 * ignore port) or when the cookie is scoped to a parent domain they share. Two
 * unrelated hosts can never work: the browser never sends one host's cookie to
 * the other, and there is no service credential an internal caller can present.
 *
 * The check is loud but not fatal. An Operator on an unsupported topology
 * otherwise gets an app that signs in and then silently serves degraded pages —
 * every server-rendered request arrives unauthenticated and nothing says so.
 * Refusing to start would say it louder still, but it would also turn an
 * upgrade into an outage for a deployment that was running before, so the
 * unsupported topology is reported at startup and then run anyway, exactly as
 * it ran before this check existed.
 */

import { logger } from "./logger.ts";
import { backendBaseUrl, frontendBaseUrl } from "./base-urls.ts";

export type AuthTopologyResult =
  | { valid: true; cookieDomain: string | undefined }
  | { valid: false; message: string };

const AUTH_COOKIE_DOMAIN_VAR = "AUTH_COOKIE_DOMAIN";

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/** True for an IPv4 literal in range, or anything containing a colon (IPv6). */
const isIpAddress = (value: string): boolean => {
  const bare =
    value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
  if (IPV4.test(bare)) {
    return bare.split(".").every((octet) => Number(octet) <= 255);
  }
  return bare.includes(":");
};

/**
 * True for a value carrying URL syntax rather than a bare domain. Matches on a
 * path separator or a scheme, so an IPv6 literal's colons don't read as one.
 */
const looksLikeUrl = (value: string): boolean =>
  value.includes("/") || /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value);

/** `example.com` scopes `app.example.com` and itself; case-insensitively. */
const isParentDomain = (host: string, domain: string): boolean =>
  host === domain || host.endsWith(`.${domain}`);

const hostnameOf = (url: string): string | undefined => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
};

const rule =
  `The two origins must share a parent domain; set ${AUTH_COOKIE_DOMAIN_VAR} ` +
  `to that domain (for example, example.com).`;

const originsClause = (backendHost: string, frontendHost: string): string =>
  `the backend host "${backendHost}" and the frontend host "${frontendHost}"`;

const badCookieDomain = (
  origins: string,
  domain: string,
  reason: string,
): AuthTopologyResult => ({
  valid: false,
  message:
    `Server-rendered requests will not be authenticated: ${origins} need a ` +
    `session cookie scoped to a ` +
    `shared parent domain, but ${AUTH_COOKIE_DOMAIN_VAR} is set to ` +
    `"${domain}", which is not usable as a cookie domain because ${reason}. ` +
    rule,
});

/**
 * Decide whether the three values can produce authenticated server-side
 * requests. `backendUrl` is the browser-facing backend URL (`BETTER_AUTH_URL`),
 * `frontendUrl` is `FRONTEND_URL`, and `cookieDomain` is the optional
 * `AUTH_COOKIE_DOMAIN`.
 */
export const checkAuthTopology = (
  backendUrl: string,
  frontendUrl: string,
  cookieDomain: string | undefined,
): AuthTopologyResult => {
  const backendHost = hostnameOf(backendUrl);
  const frontendHost = hostnameOf(frontendUrl);
  if (!backendHost || !frontendHost) {
    // Without both hostnames the topology cannot be judged either way. Name
    // whichever variable is unreadable rather than both.
    const unreadable = [
      backendHost ? undefined : `BETTER_AUTH_URL ("${backendUrl}")`,
      frontendHost ? undefined : `FRONTEND_URL ("${frontendUrl}")`,
    ]
      .filter((clause): clause is string => clause !== undefined)
      .join(" and ");
    return {
      valid: false,
      message:
        `Server-rendered requests may not be authenticated: could not read a ` +
        `hostname from ${unreadable}. ` +
        `The backend and frontend hostnames have to be compared before ` +
        `server-rendered requests can be authenticated. Set each to an ` +
        `absolute URL (for example, https://api.example.com).`,
    };
  }

  const raw = cookieDomain?.trim();
  const sameHost = backendHost === frontendHost;

  if (raw !== undefined && raw !== "") {
    const origins = originsClause(backendHost, frontendHost);
    if (looksLikeUrl(raw)) {
      return badCookieDomain(origins, raw, "it is a URL, not a bare domain");
    }
    if (raw.startsWith(".")) {
      return badCookieDomain(
        origins,
        raw,
        "it has a leading dot; use the bare domain",
      );
    }

    const domain = raw.toLowerCase();
    if (isIpAddress(domain)) {
      return badCookieDomain(origins, domain, "it is an IP address");
    }
    if (!domain.includes(".")) {
      return badCookieDomain(origins, domain, "it is a single-label domain");
    }
    if (
      !isParentDomain(backendHost, domain) ||
      !isParentDomain(frontendHost, domain)
    ) {
      return badCookieDomain(
        origins,
        domain,
        "it is not a parent domain of both",
      );
    }
    return { valid: true, cookieDomain: domain };
  }

  if (!sameHost) {
    return {
      valid: false,
      message:
        `Server-rendered requests will not be authenticated: ` +
        `${originsClause(backendHost, frontendHost)} are on ` +
        `different hosts, so the browser never sends the backend's session ` +
        `cookie to the frontend and every server-rendered request reaches the ` +
        `backend unauthenticated. ${rule}`,
    };
  }

  return { valid: true, cookieDomain: undefined };
};

/**
 * Read the three values from the environment and report — at module load,
 * before the HTTP server listens — when the topology cannot authenticate
 * server-side requests. Returns the validated cookie domain, or `undefined`
 * when there is none to apply, including on a topology that was reported.
 *
 * An unusable `AUTH_COOKIE_DOMAIN` is dropped rather than handed to
 * better-auth: a cookie scoped to a domain neither origin sits under is not
 * sent to either of them, which is a worse failure than the host-only default.
 */
export const resolveAuthCookieDomain = (): string | undefined => {
  const raw = process.env.AUTH_COOKIE_DOMAIN;
  const cookieDomain = raw?.trim() ? raw.trim() : undefined;

  const result = checkAuthTopology(
    backendBaseUrl(),
    frontendBaseUrl(),
    cookieDomain,
  );
  if (!result.valid) {
    logger.error(result.message);
    return undefined;
  }
  return result.cookieDomain;
};

/**
 * The `advanced` block that scopes session cookies to a shared parent domain.
 *
 * Returns an empty object when no domain is set, so a single-origin deployment
 * sees exactly better-auth's default host-only cookie behaviour. The block is
 * omitted entirely — better-auth is never handed a disabled or empty form.
 */
export const crossSubdomainCookieConfig = (
  domain: string | undefined,
):
  | Record<string, never>
  | {
      advanced: {
        crossSubDomainCookies: { enabled: true; domain: string };
      };
    } =>
  domain
    ? {
        advanced: {
          crossSubDomainCookies: { enabled: true as const, domain },
        },
      }
    : {};
