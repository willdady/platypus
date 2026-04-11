import { sql, and, eq, lte, inArray } from "drizzle-orm";
import { db } from "../index.ts";
import { trigger as triggerTable } from "../db/schema.ts";
import {
  executeTrigger,
  updateTriggerAfterRun,
} from "../services/trigger-execution.ts";
import { logger } from "../logger.ts";
import { validateCronExpression } from "../utils/cron.ts";
import type { CronTriggerConfig } from "@platypus/schemas";

// Advisory lock ID for trigger scheduler (same as old schedule scheduler)
const TRIGGER_SCHEDULER_LOCK_ID = 987654321;

// Check interval: 60 seconds (1 minute)
const TRIGGER_SCHEDULER_INTERVAL_MS = parseInt(
  process.env.SCHEDULE_SCHEDULER_INTERVAL_MS || "60000",
);

// Maximum concurrent trigger executions
const MAX_CONCURRENT_TRIGGERS = parseInt(
  process.env.SCHEDULE_MAX_CONCURRENT || "5",
);

/**
 * Runs items in parallel with a concurrency limit.
 * Uses a semaphore-style approach to ensure at most `limit` promises run at once.
 */
async function withConcurrencyLimit<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  const executing: Promise<void>[] = [];
  for (const item of items) {
    const promise = fn(item).finally(() => {
      executing.splice(executing.indexOf(promise), 1);
    });
    executing.push(promise);
    if (executing.length >= limit) {
      await Promise.race(executing);
    }
  }
  await Promise.all(executing);
}

/**
 * Attempts to acquire an advisory lock and runs the given function if successful.
 * This ensures only one backend instance processes triggers at a time.
 */
async function runWithLock(fn: () => Promise<void>): Promise<void> {
  // Try to acquire advisory lock (non-blocking)
  const lockResult = await db.execute(
    sql`SELECT pg_try_advisory_lock(${TRIGGER_SCHEDULER_LOCK_ID}) as acquired`,
  );

  const acquired = lockResult.rows[0]?.acquired;

  if (!acquired) {
    logger.debug(
      "Another backend instance is processing triggers, skipping this run",
    );
    return;
  }

  try {
    await fn();
  } finally {
    // Always release lock, even if processing fails
    await db.execute(
      sql`SELECT pg_advisory_unlock(${TRIGGER_SCHEDULER_LOCK_ID})`,
    );
  }
}

/**
 * Schedules a function to run at wall-clock-aligned intervals.
 *
 * Unlike setInterval (which starts from the moment the process boots),
 * this aligns execution to absolute clock boundaries. For example, with
 * a 1-minute interval, all instances will attempt to run at :00, :01,
 * :02, etc. regardless of when they started.
 *
 * This is critical for horizontal scaling: all backend instances align
 * to the same schedule, so the advisory lock contention is predictable
 * and only one instance wins each cycle.
 */
function scheduleAligned(intervalMs: number, fn: () => Promise<void>): void {
  function scheduleNext() {
    const now = Date.now();
    const nextTick = Math.ceil(now / intervalMs) * intervalMs;
    const delay = nextTick - now;

    setTimeout(async () => {
      try {
        await fn();
      } catch (error) {
        logger.error({ error }, "Scheduled job failed");
      }
      scheduleNext();
    }, delay);
  }

  scheduleNext();
}

/**
 * Processes a single trigger execution.
 * Handles errors independently so one failure doesn't block others.
 */
async function processSingleTrigger(
  job: typeof triggerTable.$inferSelect,
): Promise<void> {
  const now = new Date();

  try {
    logger.info(
      {
        triggerId: job.id,
        name: job.name,
        agentId: job.agentId,
      },
      "Processing cron trigger",
    );

    // Execute the trigger
    await executeTrigger(job);

    // Update the trigger state after successful execution
    await updateTriggerAfterRun(job.id, job);

    logger.info(
      {
        triggerId: job.id,
        name: job.name,
      },
      "Cron trigger processed successfully",
    );
  } catch (error) {
    logger.error(
      { error, triggerId: job.id, name: job.name },
      "Failed to process cron trigger",
    );

    try {
      const cronConfig = job.config as CronTriggerConfig;
      if (cronConfig.isOneOff) {
        // One-off triggers should be disabled on failure to prevent infinite retry
        await db
          .update(triggerTable)
          .set({
            lastRunAt: now,
            enabled: false,
            nextRunAt: null,
            updatedAt: now,
          })
          .where(eq(triggerTable.id, job.id));
      } else {
        // Recompute nextRunAt so the trigger retries on the next cycle
        const nextRunAt = validateCronExpression(
          cronConfig.cronExpression,
          cronConfig.timezone,
        );
        await db
          .update(triggerTable)
          .set({
            lastRunAt: now,
            nextRunAt,
            updatedAt: now,
          })
          .where(eq(triggerTable.id, job.id));
      }
    } catch (updateError) {
      logger.error(
        { error: updateError, triggerId: job.id },
        "Failed to update trigger after failure",
      );
    }
  }
}

/**
 * Processes all due cron triggers.
 * Queries for triggers where type = 'cron' AND enabled = true AND nextRunAt <= NOW(),
 * executes each one with controlled concurrency, and updates the trigger state.
 */
async function processDueTriggers(): Promise<void> {
  const now = new Date();

  // Find all due cron triggers
  const dueJobs = await db
    .select()
    .from(triggerTable)
    .where(
      and(
        eq(triggerTable.type, "cron"),
        eq(triggerTable.enabled, true),
        lte(triggerTable.nextRunAt, now),
      ),
    );

  if (dueJobs.length === 0) {
    logger.debug("No cron triggers due for execution");
    return;
  }

  logger.info(
    `Found ${dueJobs.length} cron trigger(s) due, max concurrent: ${MAX_CONCURRENT_TRIGGERS}`,
  );

  // Immediately claim all due jobs by nulling nextRunAt to prevent re-pickup
  const dueJobIds = dueJobs.map((j) => j.id);
  await db
    .update(triggerTable)
    .set({ nextRunAt: null })
    .where(inArray(triggerTable.id, dueJobIds));

  // Process triggers in parallel with controlled concurrency
  await withConcurrencyLimit(
    dueJobs,
    MAX_CONCURRENT_TRIGGERS,
    processSingleTrigger,
  );
}

/**
 * Starts the trigger scheduler.
 * This should be called after the database is initialized.
 */
export function startTriggerScheduler(): void {
  logger.info(
    `Starting trigger scheduler (interval: ${TRIGGER_SCHEDULER_INTERVAL_MS}ms, wall-clock aligned)`,
  );

  // Schedule at wall-clock-aligned intervals with advisory lock
  scheduleAligned(TRIGGER_SCHEDULER_INTERVAL_MS, async () => {
    await runWithLock(async () => {
      await processDueTriggers();
    });
  });
}
