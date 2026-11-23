import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { authPlugins, authUserFieldOverrides } from "./auth-plugins.ts";
import { requireInvitationToSignUp } from "./sign-up.ts";
import { db } from "./index.ts";
import { authBaseUrl } from "./base-urls.ts";
import * as authSchema from "./db/auth-schema.ts";
import { timezoneSchema } from "@platypus/schemas";
import {
  crossSubdomainCookieConfig,
  resolveAuthCookieDomain,
} from "./auth-cookie-domain.ts";
import { env } from "./env.ts";
import { deleteOwnedWorkspaces } from "./services/user-delete.ts";

const authCookieDomain = resolveAuthCookieDomain();

export const SESSION_LIFETIME_DAYS = 7;
export const SESSION_REFRESH_AGE_HOURS = 24;
export const SESSION_COOKIE_CACHE_MINUTES = 5;

export const SESSION_READ_WINDOW_SECONDS = 60;
export const SESSION_READ_MAX = 300;

export const auth = betterAuth({
  baseURL: authBaseUrl(),
  basePath: new URL(authBaseUrl()).pathname,
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: authSchema,
  }),
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: false,
    disableSignUp: requireInvitationToSignUp(),
  },
  user: {
    additionalFields: {
      ...authUserFieldOverrides,
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
