import { sql, and, eq, isNull, lt, lte, inArray } from "drizzle-orm";
import { db } from "../index.ts";
import {
  trigger as triggerTable,
  triggerRun as triggerRunTable,
} from "../db/schema.ts";
import {
  executeTrigger,
  updateTriggerAfterRun,
} from "../services/trigger-execution.ts";
import { logger } from "../logger.ts";
import { DEFAULT_PER_RUN_TIMEOUT_MS } from "../runs/run-registry.ts";
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
      void executing.splice(executing.indexOf(promise), 1);
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

    setTimeout(() => {
      void (async () => {
        try {
          await fn();
        } catch (error) {
          logger.error({ error }, "Scheduled job failed");
        }
        scheduleNext();
      })();
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
 * Buffer added on top of the per-run timeout before we consider a `running`
 * `trigger_run` row abandoned. Any live instance would have aborted the run
 * by `started_at + DEFAULT_PER_RUN_TIMEOUT_MS`, so anything older than that
 * plus this buffer is definitely orphaned. Five extra minutes gives the
 * normal per-run timeout path a chance to write the failure first.
 */
const RECOVERY_STALE_BUFFER_MS = 5 * 60 * 1000;

/**
 * Periodic recovery for state left behind by a server crash mid-execution.
 *
 * Two failure modes both manifest as "trigger never runs again":
 *
 * 1. `processDueTriggers` claims a due trigger by setting `nextRunAt = NULL`
 *    before invoking `executeTrigger`. If the process dies before
 *    `updateTriggerAfterRun` writes the next schedule, the trigger row is
 *    permanently stuck — the scheduler query `nextRunAt <= NOW()` is false
 *    for NULL, so the trigger is invisible on every subsequent tick.
 *
 * 2. `TriggerSink.onStart` writes a `trigger_run` row with status `running`.
 *    A crash leaves that row dangling, which clutters the UI and gives no
 *    indication the run failed.
 *
 * Critical horizontal-scaling note: a `running` row may still be a peer
 * instance's live work. We must NOT touch rows younger than
 * `DEFAULT_PER_RUN_TIMEOUT_MS + RECOVERY_STALE_BUFFER_MS`, because a live
 * instance would have aborted any run older than that via its own per-run
 * timeout. Recovery is gated on that age threshold; the advisory lock only
 * serializes concurrent recoveries, it does not prevent racing live runs.
 *
 * Same reason for `nextRunAt`: we only recompute it for triggers whose latest
 * `running` row we just failed. If `nextRunAt IS NULL` but no run row crossed
 * the staleness threshold, a peer is currently executing — leave it alone.
 */
async function recoverStuckTriggers(): Promise<void> {
  const staleThresholdMs =
    DEFAULT_PER_RUN_TIMEOUT_MS + RECOVERY_STALE_BUFFER_MS;
  const cutoff = new Date(Date.now() - staleThresholdMs);

  // Mark abandoned running runs as failed. The age cutoff guarantees no
  // live peer is still working on them.
  const orphaned = await db
    .update(triggerRunTable)
    .set({
      status: "failed",
      errorMessage: "Server restarted during execution",
      completedAt: new Date(),
    })
    .where(
      and(
        eq(triggerRunTable.status, "running"),
        lt(triggerRunTable.startedAt, cutoff),
      ),
    )
    .returning({
      id: triggerRunTable.id,
      triggerId: triggerRunTable.triggerId,
    });

  if (orphaned.length === 0) return;

  logger.warn(
    { count: orphaned.length, cutoff: cutoff.toISOString() },
    "Marked orphaned trigger runs as failed (older than per-run timeout)",
  );

  // For each trigger whose run we just failed: if its nextRunAt is NULL
  // (i.e. it was claimed but the schedule was never re-written), recompute
  // it. Restricting the recompute to these triggers — instead of every
  // NULL-nextRunAt trigger — ensures we don't reset the schedule for a
  // trigger that a peer instance has currently claimed.
  const orphanedTriggerIds = Array.from(
    new Set(orphaned.map((r) => r.triggerId)),
  );

  const stuck = await db
    .select()
    .from(triggerTable)
    .where(
      and(
        inArray(triggerTable.id, orphanedTriggerIds),
        eq(triggerTable.type, "cron"),
        eq(triggerTable.enabled, true),
        isNull(triggerTable.nextRunAt),
      ),
    );

  for (const job of stuck) {
    const cronConfig = job.config as CronTriggerConfig;
    if (cronConfig.isOneOff) continue;
    const nextRunAt = validateCronExpression(
      cronConfig.cronExpression,
      cronConfig.timezone,
    );
    if (!nextRunAt) {
      logger.error(
        { triggerId: job.id, cronExpression: cronConfig.cronExpression },
        "Failed to recompute nextRunAt during recovery (invalid cron expression?)",
      );
      continue;
    }
    await db
      .update(triggerTable)
      .set({ nextRunAt, updatedAt: new Date() })
      .where(eq(triggerTable.id, job.id));
    logger.warn(
      {
        triggerId: job.id,
        name: job.name,
        nextRunAt: nextRunAt.toISOString(),
      },
      "Recovered cron trigger with NULL nextRunAt after orphan sweep",
    );
  }
}

/**
 * Starts the trigger scheduler.
 * This should be called after the database is initialized.
 */
export function startTriggerScheduler(): void {
  logger.info(
    `Starting trigger scheduler (interval: ${TRIGGER_SCHEDULER_INTERVAL_MS}ms, wall-clock aligned)`,
  );

  // Schedule at wall-clock-aligned intervals with advisory lock. Recovery
  // and due-trigger processing share the same lock so they don't race each
  // other or peer instances. Recovery runs every tick (cheap when there's
  // nothing to do) so a crash self-heals without requiring a restart, and
  // multiple booting instances can't all sweep concurrently — the first to
  // grab the lock does it.
  scheduleAligned(TRIGGER_SCHEDULER_INTERVAL_MS, async () => {
    await runWithLock(async () => {
      try {
        await recoverStuckTriggers();
      } catch (error) {
        logger.error({ error }, "Trigger recovery sweep failed");
      }
      await processDueTriggers();
    });
  });
}
