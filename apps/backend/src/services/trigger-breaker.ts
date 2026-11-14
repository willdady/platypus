import { and, count, eq, gt, ne } from "drizzle-orm";
import { db } from "../index.ts";
import { triggerRun as triggerRunTable } from "../db/schema.ts";
import { logger } from "../logger.ts";

/**
 * The run-rate breaker for Event and Inbound Triggers.
 *
 * Nothing else bounds how often one Event Trigger may run for one entity: the
 * 5s debounce in `event-trigger-debounce.ts` folds a rapid burst into a single
 * run, but a cycle whose next event arrives minutes later — after the run that
 * caused it finished — re-enters freely. The self-actor guard blocks only the
 * Agent's own writes, so two Triggers can hand a record back and forth without
 * ever crossing it. Left unbounded, each lap burns a full Drive.
 *
 * The breaker is a standing safety property, not a remedy for one diagnosis:
 * N runs per Trigger per entity per rolling window, after which the excess
 * firings are dropped before an Agent is invoked. A dropped firing is recorded
 * as a `trigger_run` row with status `suppressed`, which is what makes the
 * trip visible on the runs page; recording it belongs to the Trigger run
 * lifecycle (`trigger-run-lifecycle.ts`), because it is a status write. This
 * module decides only whether a firing is admitted.
 *
 * The count and the ceiling live in the Operator's environment, not on the
 * Trigger: a Workspace Owner tunable is not a ceiling, and `maxRunsToKeep`
 * already shows what happens when retention starts governing run-rate
 * behaviour. See `reference/backend-configuration.mdx`.
 */

export type TriggerBreakerConfig = {
  /** Runs allowed per Trigger per entity within the window. */
  maxRuns: number;
  /** Length of the rolling window, in seconds. */
  windowSeconds: number;
  /** Suppressed rows retained per Trigger, separate from maxRunsToKeep. */
  suppressedRunsToKeep: number;
};

/** Also the threshold `validateTriggerBreakerConfig` warns above. */
const DEFAULT_TRIGGER_BREAKER_WINDOW_SECONDS = 3600;
const DEFAULT_TRIGGER_BREAKER_MAX_RUNS = 20;
const DEFAULT_TRIGGER_BREAKER_SUPPRESSED_RUNS_TO_KEEP = 20;

/**
 * Reads one positive-integer setting. An explicitly-set value that is not one
 * is refused rather than defaulted: silently enforcing a number the Operator
 * never chose is the failure this feature exists to prevent, and a limit that
 * enforces something other than it reads is worse than no limit at all.
 */
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

/** The breaker settings for this deployment. */
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

/**
 * Validates the settings and reports them at boot. Call before the server
 * accepts traffic: a malformed value must fail the deployment rather than be
 * silently replaced by a default nobody chose.
 *
 * Retention is not a separate setting to reconcile — the Trigger run
 * lifecycle's retention reads the same window — so what is left to surface is
 * the cost: the retention rule keeps every run inside the window, so a window
 * larger than the default grows `trigger_run` for the whole of it. Said out
 * loud, because it is otherwise silent.
 */
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

/**
 * Whether the next firing of `triggerId` for `entityId` exceeds the ceiling
 * and must be dropped. Callers pass only a single-entity id: firings that name
 * no entity (bulk `notification.read`) are exempt, because counting them would
 * trip a Trigger after N deletions of different Cards and stop legitimate
 * work.
 *
 * The count reads `trigger_run` itself. Suppressed rows are excluded — they
 * record firings that never ran, and counting them would hold a Trigger down
 * for as long as events keep arriving instead of letting the window roll.
 */
export const shouldSuppressTriggerRun = async (
  triggerId: string,
  entityId: string,
  // An inbound call counts inside the transaction that serialises calls for
  // one record, so the count and the row it then writes are one decision.
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
