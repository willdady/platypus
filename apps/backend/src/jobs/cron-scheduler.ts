import { sql, and, eq, lte } from "drizzle-orm";
import { db } from "../index.ts";
import { cronJob as cronJobTable } from "../db/schema.ts";
import {
  triggerCronJob,
  updateCronJobAfterRun,
} from "../services/cron-execution.ts";
import { logger } from "../logger.ts";

// Advisory lock ID for cron scheduler (distinct from memory extraction's 123456789)
const CRON_SCHEDULER_LOCK_ID = 987654321;

// Check interval: 60 seconds (1 minute)
const CRON_SCHEDULER_INTERVAL_MS = parseInt(
  process.env.CRON_SCHEDULER_INTERVAL_MS || "60000",
);

/**
 * Attempts to acquire an advisory lock and runs the given function if successful.
 * This ensures only one backend instance processes cron jobs at a time.
 */
async function runWithLock(fn: () => Promise<void>): Promise<void> {
  // Try to acquire advisory lock (non-blocking)
  const lockResult = await db.execute(
    sql`SELECT pg_try_advisory_lock(${CRON_SCHEDULER_LOCK_ID}) as acquired`,
  );

  const acquired = lockResult.rows[0]?.acquired;

  if (!acquired) {
    logger.debug(
      "Another backend instance is processing cron jobs, skipping this run",
    );
    return;
  }

  try {
    await fn();
  } finally {
    // Always release lock, even if processing fails
    await db.execute(sql`SELECT pg_advisory_unlock(${CRON_SCHEDULER_LOCK_ID})`);
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
 * Processes all due cron jobs.
 * Queries for jobs where enabled = true AND nextRunAt <= NOW(),
 * executes each one, and updates the job state.
 */
async function processDueCronJobs(): Promise<void> {
  const now = new Date();

  // Find all due cron jobs
  const dueJobs = await db
    .select()
    .from(cronJobTable)
    .where(
      and(eq(cronJobTable.enabled, true), lte(cronJobTable.nextRunAt, now)),
    );

  if (dueJobs.length === 0) {
    logger.debug("No cron jobs due for execution");
    return;
  }

  logger.info(`Found ${dueJobs.length} cron job(s) due for execution`);

  // Process each job sequentially to avoid resource exhaustion
  for (const job of dueJobs) {
    try {
      logger.info(
        {
          cronJobId: job.id,
          name: job.name,
          agentId: job.agentId,
        },
        "Processing cron job",
      );

      // Execute the cron job
      await triggerCronJob(job);

      // Update the job state after successful execution
      await updateCronJobAfterRun(
        job.id,
        job.maxChatsToKeep,
        job.isOneOff,
        job.cronExpression,
        job.timezone,
      );

      logger.info(
        {
          cronJobId: job.id,
          name: job.name,
        },
        "Cron job processed successfully",
      );
    } catch (error) {
      logger.error(
        { error, cronJobId: job.id, name: job.name },
        "Failed to process cron job",
      );

      // Don't disable the job on failure - it will retry on the next tick
      // But do update lastRunAt so we know it was attempted
      try {
        await db
          .update(cronJobTable)
          .set({
            lastRunAt: now,
            updatedAt: now,
          })
          .where(eq(cronJobTable.id, job.id));
      } catch (updateError) {
        logger.error(
          { error: updateError, cronJobId: job.id },
          "Failed to update cron job after failure",
        );
      }
    }
  }
}

/**
 * Starts the cron scheduler.
 * This should be called after the database is initialized.
 */
export function startCronScheduler(): void {
  logger.info(
    `Starting cron scheduler (interval: ${CRON_SCHEDULER_INTERVAL_MS}ms, wall-clock aligned)`,
  );

  // Schedule at wall-clock-aligned intervals with advisory lock
  scheduleAligned(CRON_SCHEDULER_INTERVAL_MS, async () => {
    await runWithLock(async () => {
      await processDueCronJobs();
    });
  });
}
