import { sql, and, eq, isNull, lt, lte, or, inArray } from "drizzle-orm";
import { db } from "../index.ts";
import {
  chat as chatTable,
  trigger as triggerTable,
  triggerRun as triggerRunTable,
} from "../db/schema.ts";
import {
  executeTrigger,
  updateTriggerAfterRun,
} from "../services/trigger-execution.ts";
import { logger } from "../logger.ts";
import { DEFAULT_PER_RUN_TIMEOUT_MS } from "../runs/run-registry.ts";
import { chatPerRunTimeoutMs } from "../runs/chat-timeouts.ts";
import { validateCronExpression } from "../utils/cron.ts";
import type { CronTriggerConfig } from "@platypus/schemas";

// Advisory lock ID for the background scheduler. The numeric value is load
// bearing across deploys: an old and a new instance must contend for the same
// lock during a rolling restart, so never change it when renaming things here.
const SCHEDULER_LOCK_ID = 987654321;

// Check interval: 60 seconds (1 minute)
const SCHEDULER_INTERVAL_MS = parseInt(
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
 * This ensures only one backend instance runs the scheduled work at a time.
 */
async function runWithLock(fn: () => Promise<void>): Promise<void> {
  // Try to acquire advisory lock (non-blocking)
  const lockResult = await db.execute(
    sql`SELECT pg_try_advisory_lock(${SCHEDULER_LOCK_ID}) as acquired`,
  );

  const acquired = lockResult.rows[0]?.acquired;

  if (!acquired) {
    logger.debug(
      "Another backend instance is running the scheduler, skipping this tick",
    );
    return;
  }

  try {
    await fn();
  } finally {
    // Always release lock, even if processing fails
    await db.execute(sql`SELECT pg_advisory_unlock(${SCHEDULER_LOCK_ID})`);
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
 * Buffer added on top of a run's own per-run timeout before we consider a
 * `running` row abandoned — shared by both sweeps below, each of which adds it
 * to the timeout its own kind of run is bounded by. Any live instance would
 * have aborted the run by `started + <its per-run timeout>`, so anything older
 * than that plus this buffer is definitely orphaned. Five extra minutes gives
 * the normal per-run timeout path a chance to write the failure first.
 */
const RECOVERY_STALE_BUFFER_MS = 5 * 60 * 1000;

/**
 * The moment before which a `running` row of any kind has no live owner:
 * the run's own per-run timeout ago, plus the buffer above. Both sweeps go
 * through here, so the one thing that makes them safe against a peer's live
 * work is stated once.
 */
function staleCutoff(perRunTimeoutMs: number): Date {
  return new Date(Date.now() - (perRunTimeoutMs + RECOVERY_STALE_BUFFER_MS));
}

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
  const cutoff = staleCutoff(DEFAULT_PER_RUN_TIMEOUT_MS);

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
 * The moment before which a `running` Chat is considered abandoned.
 *
 * Derived from `CHAT_PER_RUN_TIMEOUT_MS` — the ceiling a Chat turn actually
 * runs under (`runs/chat-timeouts.ts`) — and NOT from the Trigger's
 * `DEFAULT_PER_RUN_TIMEOUT_MS`, which is three times shorter and would fail
 * live turns. A live instance aborts any turn older than its own per-run
 * timeout, so a row past this cutoff has no live owner on any instance.
 *
 * Horizontal scaling: this env var is read per process, unlike the Trigger
 * timeout which is a code constant. Instances sharing a database must be
 * configured with the same value; one given a shorter value computes an
 * earlier cutoff and could fail a peer's live turn.
 */
export function stuckChatCutoff(): Date {
  return staleCutoff(chatPerRunTimeoutMs());
}

/**
 * Periodic recovery for Chats left `running` by a server crash mid-turn.
 *
 * `ChatSink.onStart` sets the Chat's status to `running`, and the sink is the
 * only writer of a terminal status. The per-run and per-step timeouts that
 * would otherwise end the turn are `setTimeout` handles in the in-memory run
 * registry, so a crash takes them with it and the row stays `running` for
 * ever: a sidebar spinner that never stops, a composer the frontend keeps
 * disabled, and (since #761) a Chat-list poll every 3s for as long as a tab
 * is open. Issue #762.
 *
 * Age is measured on `lastTurnAt`, the run sink's own turn-boundary signal,
 * never on `updatedAt` — auto-titling and memory extraction bump `updatedAt`
 * at their own cadence, so a background write on a dead Chat would keep the
 * row looking recent and the sweep would never fire (see `db/schema.ts`).
 * Rows predating the column fall back to `updatedAt`.
 *
 * Same horizontal-scaling reasoning as `recoverStuckTriggers`: the age cutoff
 * is what makes this safe against a peer's live work; the advisory lock only
 * serializes concurrent sweeps.
 *
 * The status written is `failed`, not `cancelled` — nobody requested a
 * cancellation, and reporting one would misdescribe the event.
 */
export async function recoverStuckChats(): Promise<void> {
  const cutoff = stuckChatCutoff();

  const orphaned = await db
    .update(chatTable)
    .set({ status: "failed", updatedAt: new Date() })
    .where(
      and(
        eq(chatTable.status, "running"),
        or(
          lt(chatTable.lastTurnAt, cutoff),
          and(isNull(chatTable.lastTurnAt), lt(chatTable.updatedAt, cutoff)),
        ),
      ),
    )
    .returning({ id: chatTable.id });

  if (orphaned.length === 0) return;

  logger.warn(
    { count: orphaned.length, cutoff: cutoff.toISOString() },
    "Marked orphaned Chats as failed (older than the Chat per-run timeout)",
  );
}

/**
 * Starts the background scheduler.
 * This should be called after the database is initialized.
 */
export function startScheduler(): void {
  logger.info(
    `Starting scheduler (interval: ${SCHEDULER_INTERVAL_MS}ms, wall-clock aligned)`,
  );

  // Schedule at wall-clock-aligned intervals with advisory lock. Both recovery
  // sweeps and due-trigger processing share the same lock so they don't race
  // each other or peer instances. Recovery runs every tick (cheap when there's
  // nothing to do) so a crash self-heals without requiring a restart, and
  // multiple booting instances can't all sweep concurrently — the first to
  // grab the lock does it. Each sweep is wrapped independently so one failing
  // doesn't skip the others.
  scheduleAligned(SCHEDULER_INTERVAL_MS, async () => {
    await runWithLock(async () => {
      try {
        await recoverStuckTriggers();
      } catch (error) {
        logger.error({ error }, "Trigger recovery sweep failed");
      }
      try {
        await recoverStuckChats();
      } catch (error) {
        logger.error({ error }, "Chat recovery sweep failed");
      }
      await processDueTriggers();
    });
  });
}
