import { and, count, eq, gt, ne } from "drizzle-orm";
import { db } from "../index.ts";
import { triggerRun as triggerRunTable } from "../db/schema.ts";
import { logger } from "../logger.ts";

export type TriggerBreakerConfig = {
  maxRuns: number;
  windowSeconds: number;
  suppressedRunsToKeep: number;
};

const DEFAULT_TRIGGER_BREAKER_WINDOW_SECONDS = 3600;
const DEFAULT_TRIGGER_BREAKER_MAX_RUNS = 20;
const DEFAULT_TRIGGER_BREAKER_SUPPRESSED_RUNS_TO_KEEP = 20;

export const readPositiveInt = (
  name: string,
  fallback: number,
  env: NodeJS.ProcessEnv,
): number => {
  const raw = env[name]?.trim();
  if (!raw) return fallback;

  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(
      `${name} must be a positive integer, got "${raw}". ` +
        `Unset it to use the default (${fallback}).`,
    );
  }
  return value;
};

export const triggerBreakerConfig = (
  env: NodeJS.ProcessEnv = process.env,
): TriggerBreakerConfig => ({
  maxRuns: readPositiveInt(
    "TRIGGER_BREAKER_MAX_RUNS",
    DEFAULT_TRIGGER_BREAKER_MAX_RUNS,
    env,
  ),
  windowSeconds: readPositiveInt(
    "TRIGGER_BREAKER_WINDOW_SECONDS",
    DEFAULT_TRIGGER_BREAKER_WINDOW_SECONDS,
    env,
  ),
  suppressedRunsToKeep: readPositiveInt(
    "TRIGGER_BREAKER_SUPPRESSED_RUNS_TO_KEEP",
    DEFAULT_TRIGGER_BREAKER_SUPPRESSED_RUNS_TO_KEEP,
    env,
  ),
});

export const validateTriggerBreakerConfig = (): TriggerBreakerConfig => {
  const config = triggerBreakerConfig();
  logger.info(config, "Trigger run-rate breaker configured");
  if (config.windowSeconds > DEFAULT_TRIGGER_BREAKER_WINDOW_SECONDS) {
    logger.warn(
      {
        windowSeconds: config.windowSeconds,
        defaultWindowSeconds: DEFAULT_TRIGGER_BREAKER_WINDOW_SECONDS,
      },
      "Trigger breaker window is longer than the default; trigger runs are retained for the whole window",
    );
  }
  return config;
};

export const shouldSuppressTriggerRun = async (
  triggerId: string,
  entityId: string,
  database: Pick<typeof db, "select"> = db,
): Promise<boolean> => {
  const { maxRuns, windowSeconds } = triggerBreakerConfig();
  const since = new Date(Date.now() - windowSeconds * 1000);

  const [row] = await database
    .select({ runs: count() })
    .from(triggerRunTable)
    .where(
      and(
        eq(triggerRunTable.triggerId, triggerId),
        eq(triggerRunTable.entityId, entityId),
        ne(triggerRunTable.status, "suppressed"),
        gt(triggerRunTable.startedAt, since),
      ),
    );

  return (row?.runs ?? 0) >= maxRuns;
};
