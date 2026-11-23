import { env } from "./env.ts";

export const backendBaseUrl = (): string =>
  env().BETTER_AUTH_URL.replace(/\/+$/, "");

export const authBaseUrl = (): string => `${backendBaseUrl()}/auth`;

export const frontendBaseUrl = (): string => env().FRONTEND_URL;
