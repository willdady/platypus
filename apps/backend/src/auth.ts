import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { authPlugins } from "./auth-plugins.ts";
import { requireInvitationToSignUp } from "./sign-up.ts";
import { db } from "./index.ts";
import { backendBaseUrl } from "./base-urls.ts";
import * as authSchema from "./db/auth-schema.ts";
import {
  crossSubdomainCookieConfig,
  resolveAuthCookieDomain,
} from "./auth-cookie-domain.ts";

// Reported at module load, before the HTTP server listens: a backend and
// frontend on unrelated hosts cannot authenticate server-side requests, and
// silently starting half-broken is the failure this names (issue #819). It
// logs and carries on — see `auth-cookie-domain.ts` for why it does not refuse
// to start.
const authCookieDomain = resolveAuthCookieDomain();

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
  session: {
    expiresIn: 60 * 60 * 24 * 7, // 7 days
    updateAge: 60 * 60 * 24, // Update session every 24 hours
    cookieCache: {
      enabled: true,
      maxAge: 5 * 60, // 5 minutes
    },
  },
  trustedOrigins: process.env.ALLOWED_ORIGINS?.split(",") || [],
  ...crossSubdomainCookieConfig(authCookieDomain),
  plugins: authPlugins,
});
