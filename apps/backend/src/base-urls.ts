/**
 * The browser-facing base URLs, resolved from the environment with the
 * development defaults.
 *
 * Read them through here rather than re-inlining the fallback. The auth
 * topology check has to validate the very URLs better-auth is configured with;
 * a second copy of a default is free to drift, and a drifted copy lets the
 * check pass on a URL the auth instance never uses.
 */

const DEFAULT_BACKEND_URL = "http://localhost:4001";
const DEFAULT_FRONTEND_URL = "http://localhost:3001";

/** `BETTER_AUTH_URL` — the backend origin the browser talks to. */
export const backendBaseUrl = (): string =>
  process.env.BETTER_AUTH_URL || DEFAULT_BACKEND_URL;

/** `FRONTEND_URL` — the origin the browser loads the app from. */
export const frontendBaseUrl = (): string =>
  process.env.FRONTEND_URL || DEFAULT_FRONTEND_URL;
