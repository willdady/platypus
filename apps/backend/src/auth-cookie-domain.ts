import { failStartup } from "./boot-env.ts";
import { backendBaseUrl, frontendBaseUrl } from "./base-urls.ts";
import { env } from "./env.ts";

export type AuthTopologyResult =
  | { valid: true; cookieDomain: string | undefined }
  | { valid: false; message: string };

const AUTH_COOKIE_DOMAIN_VAR = "AUTH_COOKIE_DOMAIN";

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

const isIpAddress = (value: string): boolean => {
  const bare =
    value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
  if (IPV4.test(bare)) {
    return bare.split(".").every((octet) => Number(octet) <= 255);
  }
  return bare.includes(":");
};

const looksLikeUrl = (value: string): boolean =>
  value.includes("/") || /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value);

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
    `This deployment cannot authenticate server-rendered requests: ` +
    `${origins} need a session cookie scoped to a ` +
    `shared parent domain, but ${AUTH_COOKIE_DOMAIN_VAR} is set to ` +
    `"${domain}", which is not usable as a cookie domain because ${reason}. ` +
    rule,
});

export const checkAuthTopology = (
  backendUrl: string,
  frontendUrl: string,
  cookieDomain: string | undefined,
): AuthTopologyResult => {
  const backendHost = hostnameOf(backendUrl);
  const frontendHost = hostnameOf(frontendUrl);
  if (!backendHost || !frontendHost) {
    const unreadable = [
      backendHost ? undefined : `BETTER_AUTH_URL ("${backendUrl}")`,
      frontendHost ? undefined : `FRONTEND_URL ("${frontendUrl}")`,
    ]
      .filter((clause): clause is string => clause !== undefined)
      .join(" and ");
    return {
      valid: false,
      message:
        `This deployment cannot authenticate server-rendered requests: could ` +
        `not read a hostname from ${unreadable}. Set each to an absolute URL ` +
        `(for example, https://api.example.com).`,
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
        `This deployment cannot authenticate server-rendered requests: ` +
        `${originsClause(backendHost, frontendHost)} are on ` +
        `different hosts, so the browser never sends the backend's session ` +
        `cookie to the frontend and every server-rendered request reaches the ` +
        `backend unauthenticated. ${rule}`,
    };
  }

  return { valid: true, cookieDomain: undefined };
};

export const resolveAuthCookieDomain = (): string | undefined => {
  const cookieDomain = env().AUTH_COOKIE_DOMAIN;

  const result = checkAuthTopology(
    backendBaseUrl(),
    frontendBaseUrl(),
    cookieDomain,
  );
  if (!result.valid) {
    failStartup(new Error(result.message));
  }
  return result.cookieDomain;
};

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
