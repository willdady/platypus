import { sql, and, eq, lte, inArray } from "drizzle-orm";
import { db } from "../index.ts";
import { schedule as scheduleTable } from "../db/schema.ts";
import {
  triggerSchedule,
  updateScheduleAfterRun,
} from "../services/schedule-execution.ts";
import { logger } from "../logger.ts";
import { validateCronExpression } from "../utils/cron.ts";

// Advisory lock ID for schedule scheduler (distinct from memory extraction's 123456789)
const SCHEDULE_SCHEDULER_LOCK_ID = 987654321;

// Check interval: 60 seconds (1 minute)
const SCHEDULE_SCHEDULER_INTERVAL_MS = parseInt(
  process.env.SCHEDULE_SCHEDULER_INTERVAL_MS || "60000",
);

// Maximum concurrent schedule executions
const MAX_CONCURRENT_SCHEDULES = parseInt(
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
 * This ensures only one backend instance processes schedules at a time.
 */
async function runWithLock(fn: () => Promise<void>): Promise<void> {
  // Try to acquire advisory lock (non-blocking)
  const lockResult = await db.execute(
    sql`SELECT pg_try_advisory_lock(${SCHEDULE_SCHEDULER_LOCK_ID}) as acquired`,
  );

  const acquired = lockResult.rows[0]?.acquired;

  if (!acquired) {
    logger.debug(
      "Another backend instance is processing schedules, skipping this run",
    );
    return;
  }

  try {
    await fn();
  } finally {
    // Always release lock, even if processing fails
    await db.execute(
      sql`SELECT pg_advisory_unlock(${SCHEDULE_SCHEDULER_LOCK_ID})`,
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
 * Processes a single schedule execution.
 * Handles errors independently so one failure doesn't block others.
 */
async function processSingleSchedule(
  job: typeof scheduleTable.$inferSelect,
): Promise<void> {
  const now = new Date();

  try {
    logger.info(
      {
        scheduleId: job.id,
        name: job.name,
        agentId: job.agentId,
      },
      "Processing schedule",
    );

    // Execute the schedule
    await triggerSchedule(job);

    // Update the schedule state after successful execution
    await updateScheduleAfterRun(
      job.id,
      job.maxChatsToKeep,
      job.isOneOff,
      job.cronExpression,
      job.timezone,
    );

    logger.info(
      {
        scheduleId: job.id,
        name: job.name,
      },
      "Schedule processed successfully",
    );
  } catch (error) {
    logger.error(
      { error, scheduleId: job.id, name: job.name },
      "Failed to process schedule",
    );

    try {
      if (job.isOneOff) {
        // One-off schedules should be disabled on failure to prevent infinite retry
        await db
          .update(scheduleTable)
          .set({
            lastRunAt: now,
            enabled: false,
            nextRunAt: null,
            updatedAt: now,
          })
          .where(eq(scheduleTable.id, job.id));
      } else {
        // Recompute nextRunAt so the schedule retries on the next cycle
        const nextRunAt = validateCronExpression(
          job.cronExpression,
          job.timezone,
        );
        await db
          .update(scheduleTable)
          .set({
            lastRunAt: now,
            nextRunAt,
            updatedAt: now,
          })
          .where(eq(scheduleTable.id, job.id));
      }
    } catch (updateError) {
      logger.error(
        { error: updateError, scheduleId: job.id },
        "Failed to update schedule after failure",
      );
    }
  }
}

/**
 * Processes all due schedules.
 * Queries for schedules where enabled = true AND nextRunAt <= NOW(),
 * executes each one with controlled concurrency, and updates the schedule state.
 */
async function processDueSchedules(): Promise<void> {
  const now = new Date();

  // Find all due schedules
  const dueJobs = await db
    .select()
    .from(scheduleTable)
    .where(
      and(eq(scheduleTable.enabled, true), lte(scheduleTable.nextRunAt, now)),
    );

  if (dueJobs.length === 0) {
    logger.debug("No schedules due for execution");
    return;
  }

  logger.info(
    `Found ${dueJobs.length} schedule(s) due, max concurrent: ${MAX_CONCURRENT_SCHEDULES}`,
  );

  // Immediately claim all due jobs by nulling nextRunAt to prevent re-pickup
  const dueJobIds = dueJobs.map((j) => j.id);
  await db
    .update(scheduleTable)
    .set({ nextRunAt: null })
    .where(inArray(scheduleTable.id, dueJobIds));

  // Process schedules in parallel with controlled concurrency
  await withConcurrencyLimit(
    dueJobs,
    MAX_CONCURRENT_SCHEDULES,
    processSingleSchedule,
  );
}

/**
 * Starts the schedule scheduler.
 * This should be called after the database is initialized.
 */
export function startScheduleScheduler(): void {
  logger.info(
    `Starting schedule scheduler (interval: ${SCHEDULE_SCHEDULER_INTERVAL_MS}ms, wall-clock aligned)`,
  );

  // Schedule at wall-clock-aligned intervals with advisory lock
  scheduleAligned(SCHEDULE_SCHEDULER_INTERVAL_MS, async () => {
    await runWithLock(async () => {
      await processDueSchedules();
    });
  });
}
