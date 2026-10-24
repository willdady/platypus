import { z } from "zod";
import { timezoneSchema } from "@platypus/schemas";

/**
 * The backend's environment variables, typed and validated (#1617).
 *
 * A malformed value stops the backend at boot, naming the variable, instead of
 * misbehaving later: a non-numeric interval used to become `NaN`, which
 * hot-loops the scheduler, and a `NaN` cap silently stops Cron Triggers.
 * `boot-env.ts` parses this before any other module loads.
 *
 * Not here: `LOG_LEVEL` and `NODE_ENV` (the logger reads them, and reports
 * this parse), the `PLATYPUS_PLUGIN*` and `ADMIN_*` variables (the plugin
 * loader and the seed validate their own), and the breaker, inbound and A2A
 * caps (validated at boot by their modules).
 */

// Named so the docs contract can pin the documented defaults.
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

const positiveInt = (fallback: number) =>
  z.coerce.number().int().positive().default(fallback);

/** `true`/`false`/`1`/`0`, any case; anything else is refused, not guessed. */
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

const envSchema = z
  .object({
    PORT: z.coerce.number().int().min(1).max(65535).default(DEFAULT_PORT),
    ALLOWED_ORIGINS: z.string({ error: "is required" }).pipe(commaList),
    // Unset falls back to the standard `PG*` variables (`databaseConfig`).
    DATABASE_URL: z.string().optional(),
    // At least 4: the notification listener and the two schedulers' locks
    // each hold one for good or for a tick, and a tick's queries need another.
    DATABASE_POOL_MAX: z.coerce
      .number()
      .int()
      .min(4)
      .default(DEFAULT_DATABASE_POOL_MAX),
    // Their development defaults live in `base-urls.ts`.
    BETTER_AUTH_URL: z.url().optional(),
    FRONTEND_URL: z.url().optional(),
    AUTH_COOKIE_DOMAIN: z.string().optional(),
    INVITATION_EXPIRY_DAYS: positiveInt(DEFAULT_INVITATION_EXPIRY_DAYS),
    REQUIRE_INVITATION_TO_SIGN_UP: boolean(false),
    TIMEZONE: timezoneSchema.default("UTC"),
    MEMORY_EXTRACTION_INTERVAL_MS: positiveInt(
      DEFAULT_MEMORY_EXTRACTION_INTERVAL_MS,
    ),
    SCHEDULE_SCHEDULER_INTERVAL_MS: positiveInt(
      DEFAULT_SCHEDULE_SCHEDULER_INTERVAL_MS,
    ),
    // `0` is allowed: it pauses Cron Triggers.
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
  })
  .superRefine((env, ctx) => {
    if (env.STORAGE_BACKEND !== "s3") return;
    for (const key of [
      "STORAGE_S3_BUCKET",
      "STORAGE_S3_ACCESS_KEY_ID",
      "STORAGE_S3_SECRET_ACCESS_KEY",
    ] as const) {
      if (!env[key]) {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: "is required when STORAGE_BACKEND=s3",
        });
      }
    }
  });

export type Env = z.infer<typeof envSchema>;

/**
 * Parse `source`, throwing one error that names every invalid variable. Values
 * are trimmed, and an empty one counts as unset, as `VAR=` in a `.env` means.
 */
export const parseEnv = (source: NodeJS.ProcessEnv = process.env): Env => {
  const present = Object.fromEntries(
    Object.entries(source)
      .map(([key, value]): [string, string | undefined] => [key, value?.trim()])
      .filter(([, value]) => value),
  );
  const result = envSchema.safeParse(present);
  if (result.success) return result.data;
  const problems = result.error.issues.map(
    (issue) => `${issue.path.join(".")}: ${issue.message}`,
  );
  throw new Error(`Invalid environment variables: ${problems.join("; ")}`);
};

/**
 * The validated environment. Re-read on every call, so a test that sets a
 * variable sees it.
 */
// ponytail: re-parses per call (microseconds); cache it if a hot path shows it.
export const env = (): Env => parseEnv();
