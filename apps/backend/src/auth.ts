import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { authPlugins } from "./auth-plugins.ts";
import { requireInvitationToSignUp } from "./sign-up.ts";
import { db } from "./index.ts";
import { backendBaseUrl } from "./base-urls.ts";
import * as authSchema from "./db/auth-schema.ts";
import { timezoneSchema } from "@platypus/schemas";
import {
  crossSubdomainCookieConfig,
  resolveAuthCookieDomain,
} from "./auth-cookie-domain.ts";
import { env } from "./env.ts";
import { deleteOwnedWorkspaces } from "./services/user-delete.ts";

// Resolved at module load, before the HTTP server listens: a backend and
// frontend topology that cannot authenticate server-side requests stops boot,
// naming the hostnames and `AUTH_COOKIE_DOMAIN` (issue #819, #1761). A backend
// that started would sign people in and then silently serve degraded pages.
const authCookieDomain = resolveAuthCookieDomain();

/**
 * Session lifetimes. Fixed rather than Operator settings: changing the expiry
 * does not make a deployment safer, and leaving the revocation delay implicit
 * does. A session lasts this long from its last touch, a read extends it at
 * most once per refresh age (so a stolen cookie is useless within a day of the
 * User's last request), and the cookie cache only defers the database read,
 * never the expiry.
 */
export const SESSION_LIFETIME_DAYS = 7;
export const SESSION_REFRESH_AGE_HOURS = 24;
/** How long a browser may trust its cached copy of the session. */
export const SESSION_COOKIE_CACHE_MINUTES = 5;

/**
 * `/get-session`'s own rate limit: a rolling minute, 300 reads. Generous on
 * purpose — the path is read on every page load and again whenever a tab
 * regains focus, by every tab — and still finite, so a runaway client cannot
 * poll it forever. Fixed rather than configurable: it is an internal safety
 * bound, not a deployment knob.
 */
export const SESSION_READ_WINDOW_SECONDS = 60;
export const SESSION_READ_MAX = 300;

export const auth = betterAuth({
  baseURL: backendBaseUrl(),
  basePath: "/auth",
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: authSchema,
  }),
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: false, // Set to true for production
    // Closing public sign-up is the library's own switch, not a guard in
    // front of a live endpoint (ADR-0019). Sign-in, password changes and the
    // admin plugin's create-user API do not consult it, so an Invitation link
    // still redeems into an account and the first-boot seed still runs.
    disableSignUp: requireInvitationToSignUp(),
  },
  user: {
    additionalFields: {
      // The User timezone: an IANA name, or null when unset
      timezone: {
        type: "string",
        required: false,
        input: true,
        validator: { input: timezoneSchema.nullable() },
      },
    },
  },
  databaseHooks: {
    user: {
      delete: {
        // The User row's cascade would take their Workspaces' rows but not
        // their Sandboxes or stored files (issue #1610).
        before: async (user) => {
          await deleteOwnedWorkspaces(user.id);
        },
      },
    },
  },
  session: {
    expiresIn: 60 * 60 * 24 * SESSION_LIFETIME_DAYS,
    updateAge: 60 * 60 * SESSION_REFRESH_AGE_HOURS,
    cookieCache: {
      enabled: true,
      maxAge: 60 * SESSION_COOKIE_CACHE_MINUTES,
    },
  },
  rateLimit: {
    // better-auth's default limiter counts a rolling window from the *last*
    // request, so a client that reads the session at least once every 10
    // seconds never resets and hits the 100 cap: a page reload then gets a
    // 429, which the frontend reports as a failed session read (#1216).
    // `/get-session` gets its own, far larger bound instead of an exemption;
    // the credential paths keep the default limits.
    customRules: {
      "/get-session": {
        window: SESSION_READ_WINDOW_SECONDS,
        max: SESSION_READ_MAX,
      },
    },
  },
  trustedOrigins: env().ALLOWED_ORIGINS,
  ...crossSubdomainCookieConfig(authCookieDomain),
  plugins: authPlugins,
});
