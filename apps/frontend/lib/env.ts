import "server-only";
import { z } from "zod";

/**
 * The frontend's runtime environment, validated. Every server-side read of a
 * backend URL goes through here rather than `process.env` with a `|| ""`
 * fallback: an empty base URL silently turns every backend request into a
 * relative one against the frontend itself.
 *
 * `instrumentation.ts` parses it once at startup so a misconfigured deployment
 * fails fast instead of serving pages that cannot reach the backend.
 */

const httpUrl = z.url({ protocol: /^https?$/ });

const envSchema = z.object({
  /** The backend as the browser reaches it. */
  BACKEND_URL: httpUrl,
  /** The backend as the server reaches it, inside Docker. Empty means unset. */
  INTERNAL_BACKEND_URL: z.preprocess(
    (value) => (value === "" ? undefined : value),
    httpUrl.optional(),
  ),
});

export type Env = z.infer<typeof envSchema>;

export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(
      `Invalid frontend environment. Check these variables:\n${problems}`,
    );
  }
  return result.data;
}

/** The validated environment, read at request time. */
export function getEnv(): Env {
  return parseEnv(process.env);
}

/** The backend URL for server-side requests: the internal one when set. */
export function serverBackendUrl(env: Env = getEnv()): string {
  return env.INTERNAL_BACKEND_URL ?? env.BACKEND_URL;
}
