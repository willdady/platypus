import { env } from "./env.ts";

/**
 * The browser-facing base URLs, read from the validated environment.
 *
 * Read them through here rather than re-inlining the environment read. The
 * auth topology check has to validate the very URLs better-auth is configured
 * with; a second copy is free to drift, and a drifted copy lets the check pass
 * on a URL the auth instance never uses.
 *
 * Both are required deployment settings (`env.ts`), so neither has a fallback:
 * a missing one stops the backend at boot rather than silently pointing links
 * and auth redirects at localhost.
 */

/**
 * `BETTER_AUTH_URL` — the backend URL the browser talks to, without trailing
 * slashes. It may carry a path (`https://host/api`) when a reverse proxy serves
 * the backend under a prefix it strips, so build links from this rather than
 * from the request's host.
 */
export const backendBaseUrl = (): string =>
  env().BETTER_AUTH_URL.replace(/\/+$/, "");

/** The browser-facing URL of the `/auth/*` routes, prefix included. */
export const authBaseUrl = (): string => `${backendBaseUrl()}/auth`;

/** `FRONTEND_URL` — the origin the browser loads the app from. */
export const frontendBaseUrl = (): string => env().FRONTEND_URL;
