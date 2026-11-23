import { z } from "zod";
import { artifactScriptOriginSchema, timezoneSchema } from "@platypus/schemas";

const DEFAULT_PORT = 4001;
const DEFAULT_DATABASE_POOL_MAX = 10;
const DEFAULT_INVITATION_EXPIRY_DAYS = 7;
const DEFAULT_MEMORY_EXTRACTION_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_SCHEDULE_SCHEDULER_INTERVAL_MS = 60 * 1000;
const DEFAULT_SCHEDULE_MAX_CONCURRENT = 5;
const DEFAULT_CHAT_PER_STEP_TIMEOUT_MS = 2 * 60 * 1000;
const DEFAULT_CHAT_PER_RUN_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_TRIGGER_PER_STEP_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_TRIGGER_PER_RUN_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_ARTIFACT_SCRIPT_ORIGINS = "https://cdnjs.cloudflare.com";

const positiveInt = (fallback: number) =>
  z.coerce.number().int().positive().default(fallback);

const boolean = (fallback: boolean) =>
  z
    .string()
    .toLowerCase()
    .pipe(z.enum(["true", "false", "1", "0"]))
    .transform((v) => v === "true" || v === "1")
    .default(fallback);

const commaList = z
  .string()
  .transform((v) => v.split(",").map((entry) => entry.trim()))
  .pipe(z.array(z.string().min(1, "must not contain an empty entry")));

const requiredUrl = (protocol?: RegExp) =>
  z
    .string({ error: "is required" })
    .pipe(protocol ? z.url({ protocol }) : z.url());

const artifactScriptOrigins = z
  .string()
  .default(DEFAULT_ARTIFACT_SCRIPT_ORIGINS)
  .transform((value) => value.split(/\s+/).filter((entry) => entry.length > 0))
  .pipe(z.array(artifactScriptOriginSchema));

const databaseUrlSchema = requiredUrl(/^postgres(ql)?$/);

const envSchema = z
  .object({
    PORT: z.coerce.number().int().min(1).max(65535).default(DEFAULT_PORT),
    ALLOWED_ORIGINS: z.string({ error: "is required" }).pipe(commaList),
    DATABASE_URL: databaseUrlSchema,
    DATABASE_POOL_MAX: positiveInt(DEFAULT_DATABASE_POOL_MAX),
    BETTER_AUTH_URL: requiredUrl(),
    FRONTEND_URL: requiredUrl(),
    AUTH_COOKIE_DOMAIN: z.string().optional(),
    INVITATION_EXPIRY_DAYS: positiveInt(DEFAULT_INVITATION_EXPIRY_DAYS),
    REQUIRE_INVITATION_TO_SIGN_UP: boolean(true),
    TIMEZONE: timezoneSchema.default("UTC"),
    MEMORY_EXTRACTION_INTERVAL_MS: positiveInt(
      DEFAULT_MEMORY_EXTRACTION_INTERVAL_MS,
    ),
    SCHEDULE_SCHEDULER_INTERVAL_MS: positiveInt(
      DEFAULT_SCHEDULE_SCHEDULER_INTERVAL_MS,
    ),
    SCHEDULE_MAX_CONCURRENT: z.coerce
      .number()
      .int()
      .min(0)
      .default(DEFAULT_SCHEDULE_MAX_CONCURRENT),
    CHAT_PER_STEP_TIMEOUT_MS: positiveInt(DEFAULT_CHAT_PER_STEP_TIMEOUT_MS),
    CHAT_PER_RUN_TIMEOUT_MS: positiveInt(DEFAULT_CHAT_PER_RUN_TIMEOUT_MS),
    TRIGGER_PER_STEP_TIMEOUT_MS: positiveInt(
      DEFAULT_TRIGGER_PER_STEP_TIMEOUT_MS,
    ),
    TRIGGER_PER_RUN_TIMEOUT_MS: positiveInt(DEFAULT_TRIGGER_PER_RUN_TIMEOUT_MS),
    EGRESS_ALLOW_PRIVATE_NETWORKS: boolean(true),
    EGRESS_ALLOW_LOOPBACK_MCP: boolean(false),
    A2A_PUSH_ALLOW_PRIVATE_NETWORKS: boolean(false),
    STORAGE_BACKEND: z.enum(["disk", "s3"]).default("disk"),
    STORAGE_DISK_PATH: z.string().default("./data/files"),
    STORAGE_PUBLIC_URL: z
      .url()
      .transform((v) => v.replace(/\/+$/, ""))
      .optional(),
    STORAGE_S3_BUCKET: z.string().optional(),
    STORAGE_S3_REGION: z.string().default("us-east-1"),
    STORAGE_S3_ENDPOINT: z.url().optional(),
    STORAGE_S3_ACCESS_KEY_ID: z.string().optional(),
    STORAGE_S3_SECRET_ACCESS_KEY: z.string().optional(),
    GITHUB_TOKEN: z.string().optional(),
    ARTIFACT_SCRIPT_ORIGINS: artifactScriptOrigins,
  })
  .superRefine((env, ctx) => {
    if (env.STORAGE_BACKEND !== "s3") return;
    if (!env.STORAGE_S3_BUCKET) {
      ctx.addIssue({
        code: "custom",
        path: ["STORAGE_S3_BUCKET"],
        message: "is required when STORAGE_BACKEND=s3",
      });
    }
    for (const [key, partner] of [
      ["STORAGE_S3_ACCESS_KEY_ID", "STORAGE_S3_SECRET_ACCESS_KEY"],
      ["STORAGE_S3_SECRET_ACCESS_KEY", "STORAGE_S3_ACCESS_KEY_ID"],
    ] as const) {
      if (env[partner] && !env[key]) {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: `is required when ${partner} is set; set both or neither`,
        });
      }
    }
  });

export type Env = z.infer<typeof envSchema>;

const EMPTY_VALUE_IS_MEANINGFUL = new Set(["ARTIFACT_SCRIPT_ORIGINS"]);

export const parseEnv = (source: NodeJS.ProcessEnv = process.env): Env => {
  const present = Object.fromEntries(
    Object.entries(source)
      .map(([key, value]): [string, string | undefined] => [key, value?.trim()])
      .filter(
        ([key, value]) => EMPTY_VALUE_IS_MEANINGFUL.has(key) || Boolean(value),
      ),
  );
  const result = envSchema.safeParse(present);
  if (result.success) return result.data;
  const problems = result.error.issues.map(
    (issue) => `${issue.path.join(".")}: ${issue.message}`,
  );
  throw new Error(`Invalid environment variables: ${problems.join("; ")}`);
};

export const databaseUrl = (
  source: NodeJS.ProcessEnv = process.env,
): string => {
  const result = databaseUrlSchema.safeParse(source.DATABASE_URL?.trim());
  if (!result.success) {
    const message = result.error.issues[0]?.message ?? "is invalid";
    throw new Error(`Invalid environment variables: DATABASE_URL: ${message}`);
  }
  return result.data;
};

export const env = (): Env => parseEnv();
