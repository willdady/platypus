import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin } from "better-auth/plugins";
import { db } from "./index.ts";
import { backendBaseUrl } from "./base-urls.ts";
import * as authSchema from "./db/auth-schema.ts";
import {
  crossSubdomainCookieConfig,
  resolveAuthCookieDomain,
} from "./auth-cookie-domain.ts";

// Fatal at module load, before the HTTP server listens: a backend and frontend
// on unrelated hosts cannot authenticate server-side requests, and silently
// starting half-broken is the failure this refuses (issue #819).
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
  plugins: [admin()],
});
