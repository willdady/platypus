import "server-only";
import { z } from "zod";

const httpUrl = z.url({ protocol: /^https?$/ });

const envSchema = z.object({
  BACKEND_URL: httpUrl,
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

export function getEnv(): Env {
  return parseEnv(process.env);
}

export function serverBackendUrl(env: Env = getEnv()): string {
  return env.INTERNAL_BACKEND_URL ?? env.BACKEND_URL;
}
