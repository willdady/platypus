import { and, count, desc, eq, gt, lte, notInArray, ne } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "../index.ts";
import { triggerRun as triggerRunTable } from "../db/schema.ts";
import { logger } from "../logger.ts";
import type { WebhookEvent } from "@platypus/schemas";

/**
 * The run-rate breaker for Event Triggers.
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
 * trip visible on the runs page.
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

export const DEFAULT_TRIGGER_BREAKER_MAX_RUNS = 20;
export const DEFAULT_TRIGGER_BREAKER_WINDOW_SECONDS = 3600;
export const DEFAULT_TRIGGER_BREAKER_SUPPRESSED_RUNS_TO_KEEP = 20;

export const TRIGGER_BREAKER_MAX_RUNS_ENV = "TRIGGER_BREAKER_MAX_RUNS";
export const TRIGGER_BREAKER_WINDOW_SECONDS_ENV =
  "TRIGGER_BREAKER_WINDOW_SECONDS";
export const TRIGGER_BREAKER_SUPPRESSED_RUNS_TO_KEEP_ENV =
  "TRIGGER_BREAKER_SUPPRESSED_RUNS_TO_KEEP";

/**
 * Reads one positive-integer setting. An explicitly-set value that is not one
 * is refused rather than defaulted: silently enforcing a number the Operator
 * never chose is the failure this feature exists to prevent, and a limit that
 * enforces something other than it reads is worse than no limit at all.
 */
const readPositiveInt = (
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
    TRIGGER_BREAKER_MAX_RUNS_ENV,
    DEFAULT_TRIGGER_BREAKER_MAX_RUNS,
    env,
  ),
  windowSeconds: readPositiveInt(
    TRIGGER_BREAKER_WINDOW_SECONDS_ENV,
    DEFAULT_TRIGGER_BREAKER_WINDOW_SECONDS,
    env,
  ),
  suppressedRunsToKeep: readPositiveInt(
    TRIGGER_BREAKER_SUPPRESSED_RUNS_TO_KEEP_ENV,
    DEFAULT_TRIGGER_BREAKER_SUPPRESSED_RUNS_TO_KEEP,
    env,
  ),
});

/**
 * Validates the settings and reports them at boot. Call before the server
 * accepts traffic: a malformed value must fail the deployment rather than be
 * silently replaced by a default nobody chose.
 *
 * Retention is not a separate setting to reconcile — `retainTriggerRuns` reads
 * the same window — so what is left to surface is the cost: the retention rule
 * keeps every run inside the window, so a window larger than the default grows
 * `trigger_run` for the whole of it. Said out loud, because it is otherwise
 * silent.
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
): Promise<boolean> => {
  const { maxRuns, windowSeconds } = triggerBreakerConfig();
  const since = new Date(Date.now() - windowSeconds * 1000);

  const [row] = await db
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

/**
 * Drops one firing: writes the `suppressed` row the Operator sees, then trims
 * the Trigger's run history. Both belong together — the row is what makes the
 * trip visible, and retention is what stops a runaway from filling the table
 * with the evidence — so a caller cannot record a suppression and forget to
 * bound it. Called in place of the run it would have started; it carries the
 * same event fields a run row would, and no stats or completion time, because
 * no Agent was invoked.
 */
export const suppressTriggerRun = async (input: {
  triggerId: string;
  maxRunsToKeep: number;
  entityId: string;
  eventType: WebhookEvent;
  eventData: unknown;
}): Promise<void> => {
  const now = new Date();
  await db.insert(triggerRunTable).values({
    id: nanoid(),
    triggerId: input.triggerId,
    status: "suppressed",
    entityId: input.entityId,
    eventType: input.eventType,
    eventData: input.eventData ?? null,
    startedAt: now,
    createdAt: now,
  });

  await retainTriggerRuns(input.triggerId, input.maxRunsToKeep);
};

/**
 * Retention for one Trigger's runs, applied after every run and every
 * suppression.
 *
 * Replaces the old "newest maxRunsToKeep rows" rule with a union, because the
 * breaker counts rows `maxRunsToKeep` may have deleted: a Trigger busier than
 * its retention budget would otherwise have its own history pruned out from
 * under the count, and at `maxRunsToKeep: 1` the ceiling could never trip.
 *
 * `keep = (newest maxRunsToKeep) ∪ (started_at within the breaker window)`
 *
 * Suppressed rows are budgeted separately: a runaway produces them fast, and
 * sharing `maxRunsToKeep` would evict the runs that explain the incident in
 * favour of the evidence of their own suppression.
 */
export const retainTriggerRuns = async (
  triggerId: string,
  maxRunsToKeep: number,
): Promise<void> => {
  const { windowSeconds, suppressedRunsToKeep } = triggerBreakerConfig();
  let deleted = 0;

  // Nothing to prune when the Trigger holds fewer than the budget: the newest
  // query returning a short page means it returned every normal row there is.
  if (maxRunsToKeep > 0) {
    const newest = await db
      .select({ id: triggerRunTable.id })
      .from(triggerRunTable)
      .where(
        and(
          eq(triggerRunTable.triggerId, triggerId),
          ne(triggerRunTable.status, "suppressed"),
        ),
      )
      .orderBy(desc(triggerRunTable.startedAt))
      .limit(maxRunsToKeep);

    if (newest.length >= maxRunsToKeep) {
      // The window half of the union is expressed as a predicate rather than
      // an id list: selecting every row inside the window would grow the
      // `notInArray` argument with the Trigger's throughput, on a query that
      // runs after every run. `startedAt` is NOT NULL, so `<= since` is the
      // exact complement of the `> since` the count uses.
      const since = new Date(Date.now() - windowSeconds * 1000);
      const removed = await db
        .delete(triggerRunTable)
        .where(
          and(
            eq(triggerRunTable.triggerId, triggerId),
            ne(triggerRunTable.status, "suppressed"),
            lte(triggerRunTable.startedAt, since),
            notInArray(
              triggerRunTable.id,
              newest.map((row) => row.id),
            ),
          ),
        )
        .returning({ id: triggerRunTable.id });
      deleted += removed.length;
    }
  }

  const suppressed = await db
    .select({ id: triggerRunTable.id })
    .from(triggerRunTable)
    .where(
      and(
        eq(triggerRunTable.triggerId, triggerId),
        eq(triggerRunTable.status, "suppressed"),
      ),
    )
    .orderBy(desc(triggerRunTable.startedAt))
    .limit(suppressedRunsToKeep);

  if (suppressed.length >= suppressedRunsToKeep) {
    const removedSuppressed = await db
      .delete(triggerRunTable)
      .where(
        and(
          eq(triggerRunTable.triggerId, triggerId),
          eq(triggerRunTable.status, "suppressed"),
          notInArray(
            triggerRunTable.id,
            suppressed.map((row) => row.id),
          ),
        ),
      )
      .returning({ id: triggerRunTable.id });
    deleted += removedSuppressed.length;
  }

  if (deleted > 0) {
    logger.info(
      {
        triggerId,
        deletedCount: deleted,
        maxRunsToKeep,
        windowSeconds,
        suppressedRunsToKeep,
      },
      "Cleaned up old trigger runs",
    );
  }
};
