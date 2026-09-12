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
 * The check is deliberately fatal. An Operator on an unsupported topology
 * otherwise gets an app that signs in and then silently serves degraded pages —
 * every server-rendered request arrives unauthenticated and nothing says so.
 */

export type AuthTopologyResult =
  | { valid: true; cookieDomain: string | undefined }
  | { valid: false; message: string };

const AUTH_COOKIE_DOMAIN_VAR = "AUTH_COOKIE_DOMAIN";

const DEFAULT_BACKEND_URL = "http://localhost:4001";
const DEFAULT_FRONTEND_URL = "http://localhost:3001";

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
    `Refusing to start: ${origins} need a session cookie scoped to a ` +
    `shared parent domain, but ${AUTH_COOKIE_DOMAIN_VAR} is set to ` +
    `"${domain}", which cannot scope a cookie because ${reason}. ${rule}`,
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
    return {
      valid: false,
      message:
        `Refusing to start: could not read a hostname from ` +
        `BETTER_AUTH_URL ("${backendUrl}") or FRONTEND_URL ("${frontendUrl}"). ` +
        `Both must be absolute URLs.`,
    };
  }

  const domain = cookieDomain?.trim().replace(/^\./, "").toLowerCase();
  const sameHost = backendHost === frontendHost;

  if (domain !== undefined && domain !== "") {
    const origins = originsClause(backendHost, frontendHost);
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
        `Refusing to start: ${originsClause(backendHost, frontendHost)} are on ` +
        `different hosts, so the browser never sends the backend's session ` +
        `cookie to the frontend and every server-rendered request reaches the ` +
        `backend unauthenticated. ${rule}`,
    };
  }

  return { valid: true, cookieDomain: undefined };
};

/**
 * Read the three values from the environment and throw — fatally, at module
 * load, before the HTTP server listens — when the topology cannot authenticate
 * server-side requests. Returns the validated cookie domain, if any.
 */
export const resolveAuthCookieDomain = (): string | undefined => {
  const backendUrl = process.env.BETTER_AUTH_URL || DEFAULT_BACKEND_URL;
  const frontendUrl = process.env.FRONTEND_URL || DEFAULT_FRONTEND_URL;
  const raw = process.env.AUTH_COOKIE_DOMAIN;
  const cookieDomain = raw?.trim() ? raw.trim() : undefined;

  const result = checkAuthTopology(backendUrl, frontendUrl, cookieDomain);
  if (!result.valid) {
    throw new Error(result.message);
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
