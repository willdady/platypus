import {
  and,
  asc,
  count,
  eq,
  isNull,
  lt,
  lte,
  not,
  or,
  inArray,
  sql,
} from "drizzle-orm";
import type { CronTriggerConfig } from "@platypus/schemas";
import { db } from "../index.ts";
import {
  chat as chatTable,
  trigger as triggerTable,
  triggerRun as triggerRunTable,
  triggerRunEvent as triggerRunEventTable,
} from "../db/schema.ts";
import { fireTrigger } from "../services/trigger-firing.ts";
import { sendInboundTokenReminders } from "../services/inbound-trigger.ts";
import { sendA2aTokenReminders } from "../services/a2a-token.ts";
import {
  narrowTriggerConfig,
  nextCronRunAt,
  type TriggerRow,
} from "../services/trigger.ts";
import { logger } from "../logger.ts";
import { ADVISORY_LOCK_IDS } from "../db/advisory-lock.ts";
import {
  chatRunStale,
  runHeartbeatCutoff,
} from "../runs/chat-run-heartbeat.ts";
import { triggerPerRunTimeoutMs } from "../runs/trigger-timeouts.ts";
import { onA2aTurnEnded, pushMissedA2aEnds } from "../services/a2a-push.ts";

// Check interval: 60 seconds (1 minute)
const SCHEDULER_INTERVAL_MS = parseInt(
  process.env.SCHEDULE_SCHEDULER_INTERVAL_MS || "60000",
);

// Maximum Cron Trigger runs in flight at once, across every instance sharing
// the database. Event Trigger runs are not counted.
const MAX_CONCURRENT_TRIGGERS = parseInt(
  process.env.SCHEDULE_MAX_CONCURRENT || "5",
);

/**
 * Attempts to acquire an advisory lock and runs the given function if successful.
 * This ensures only one backend instance runs the scheduled work at a time.
 *
 * `lockId` is load bearing across deploys — see `ADVISORY_LOCK_IDS`. Each
 * background job passes its own, so jobs contend only with their own peers.
 *
 * An advisory lock belongs to the connection that took it, and `db` is a pool,
 * so the lock and its unlock go through one connection checked out for the
 * whole tick. Sent through `db` they could land on different connections: the
 * unlock would then release nothing, and the lock would stay held by an idle
 * pooled connection, skipping every peer's ticks until pg-pool closed it.
 * `fn`'s own queries still go through the pool; only the lock needs the
 * dedicated connection.
 */
export async function runWithLock(
  lockId: number,
  fn: () => Promise<void>,
): Promise<void> {
  const client = await db.$client.connect();
  // Handed to `release`: an error destroys the connection instead of returning
  // it to the pool, ending its session and with it any lock it still holds.
  // Set only when a lock query itself fails, leaving the session in a state we
  // cannot vouch for; `fn` failing says nothing about the connection.
  let broken: Error | undefined;

  try {
    let acquired: boolean | undefined;
    try {
      const lockResult = await client.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_lock($1) as acquired",
        [lockId],
      );
      acquired = lockResult.rows[0]?.acquired;
    } catch (error) {
      broken = toError(error);
      throw error;
    }

    if (!acquired) {
      logger.debug(
        { lockId },
        "Another backend instance holds this job's lock, skipping this tick",
      );
      return;
    }

    try {
      await fn();
    } finally {
      try {
        const unlockResult = await client.query<{ released: boolean }>(
          "SELECT pg_advisory_unlock($1) as released",
          [lockId],
        );
        if (!unlockResult.rows[0]?.released) {
          logger.warn(
            { lockId },
            "Unlock found no job lock held by this connection",
          );
        }
      } catch (error) {
        broken = toError(error);
        logger.error(
          { error, lockId },
          "Failed to release a job lock, discarding its connection",
        );
      }
    }
  } finally {
    client.release(broken);
  }
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
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
export function scheduleAligned(
  name: string,
  intervalMs: number,
  fn: () => Promise<void>,
): void {
  function scheduleNext() {
    const now = Date.now();
    const nextTick = (Math.floor(now / intervalMs) + 1) * intervalMs;
    const delay = nextTick - now;

    setTimeout(() => {
      void (async () => {
        try {
          await fn();
        } catch (error) {
          logger.error({ error, job: name }, "Scheduled job failed");
        }
        scheduleNext();
      })();
    }, delay);
  }

  scheduleNext();
}

/**
 * True while the Trigger has a `running` run of its own. Any `running` row
 * counts: the stale-run sweep runs first in the same tick, so a row abandoned
 * by a crash has already been failed.
 */
const hasRunningRun = sql`exists (select 1 from ${triggerRunTable} where ${triggerRunTable.triggerId} = ${triggerTable.id} and ${triggerRunTable.status} = 'running')`;

/** The row's narrowed cron config, or `null` — logged — when it has none. */
const cronConfigOrNull = (job: TriggerRow): CronTriggerConfig | null => {
  try {
    const typed = narrowTriggerConfig(job);
    if (typed.type === "cron") return typed.config;
  } catch (error) {
    logger.error(
      { triggerId: job.id, error },
      "Skipped a malformed cron trigger",
    );
  }
  return null;
};

/**
 * Starts the due cron Triggers, oldest `nextRunAt` first, while slots remain
 * under the cluster-wide cap, and returns without waiting for their runs.
 *
 * Each Trigger is claimed by its own conditional update, which writes its next
 * schedule (a one-off is disabled instead) and matches only while the Trigger
 * is enabled, due and not already running. `RETURNING` hands the row to the
 * one process whose update matched, so a Trigger is fired once however many
 * ticks race for it, and a crash after the claim can never leave it without a
 * schedule. The count-then-claim relies on the scheduler lock: no peer claims
 * between the two. A run claimed by the previous tick counts only once its
 * run row exists, so a tick landing in that gap can undercount by those runs;
 * it cannot fire them twice, as their claim already moved `nextRunAt` on.
 *
 * A due Trigger still running from its last firing is skipped — its
 * `nextRunAt` moves to the next slot — and takes no slot. One left over for
 * want of a slot stays due, and a later tick claims it.
 *
 * The runs are observed only through `processSingleTrigger`'s logging;
 * `fireTrigger` never rejects, so nothing is left unhandled.
 */
export async function processDueTriggers(): Promise<void> {
  const now = new Date();

  const [{ running }] = await db
    .select({ running: count() })
    .from(triggerRunTable)
    .innerJoin(triggerTable, eq(triggerTable.id, triggerRunTable.triggerId))
    .where(
      and(eq(triggerRunTable.status, "running"), eq(triggerTable.type, "cron")),
    );
  let slots = MAX_CONCURRENT_TRIGGERS - running;

  const isDue = and(
    eq(triggerTable.type, "cron"),
    eq(triggerTable.enabled, true),
    lte(triggerTable.nextRunAt, now),
  );
  const due = await db
    .select()
    .from(triggerTable)
    .where(isDue)
    .orderBy(asc(triggerTable.nextRunAt));

  for (const job of due) {
    const config = cronConfigOrNull(job);
    if (!config) continue;
    // A one-off needs no next slot to be claimed, only to be skipped.
    const nextRunAt = nextCronRunAt(config);
    if (!nextRunAt && !config.isOneOff) {
      logger.error(
        { triggerId: job.id, cronExpression: config.cronExpression },
        "Failed to compute next run for cron trigger; left unclaimed",
      );
      continue;
    }

    if (slots > 0) {
      const [claimed] = await db
        .update(triggerTable)
        .set(
          config.isOneOff
            ? { enabled: false, nextRunAt: null, updatedAt: now }
            : { nextRunAt, updatedAt: now },
        )
        .where(and(eq(triggerTable.id, job.id), isDue, not(hasRunningRun)))
        .returning();
      if (claimed) {
        slots--;
        void processSingleTrigger(claimed);
        continue;
      }
    }

    if (!nextRunAt) continue;
    const skipped = await db
      .update(triggerTable)
      .set({ nextRunAt, updatedAt: now })
      .where(and(eq(triggerTable.id, job.id), isDue, hasRunningRun))
      .returning({ id: triggerTable.id });
    if (skipped.length > 0) {
      logger.info(
        { triggerId: job.id, nextRunAt: nextRunAt.toISOString() },
        "Skipped a cron firing: its previous run is still going",
      );
    }
  }
}

/**
 * Fires one claimed cron Trigger. Firing owns the run and every bit of
 * bookkeeping after it, and never rejects, so one Trigger's failure cannot
 * block the others.
 */
async function processSingleTrigger(job: TriggerRow): Promise<void> {
  logger.info(
    { triggerId: job.id, name: job.name, agentId: job.agentId },
    "Processing cron trigger",
  );
  const outcome = await fireTrigger(job, { kind: "cron" });
  logger.info(
    { triggerId: job.id, name: job.name, outcome },
    "Cron trigger processed",
  );
}

/**
 * Buffer added on top of a run's own per-run timeout before we consider a
 * `running` row abandoned — shared by both sweeps below, each of which adds it
 * to the timeout its own kind of run is bounded by: `TRIGGER_PER_RUN_TIMEOUT_MS`
 * for a Trigger run, `CHAT_PER_RUN_TIMEOUT_MS` for a Chat turn. Any live
 * instance would have aborted the run by `started + <its per-run timeout>`, so
 * anything older than that plus this buffer is definitely orphaned. Five extra
 * minutes gives the normal per-run timeout path a chance to write the failure
 * first.
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
 * The moment before which a `running` Trigger run is considered abandoned.
 *
 * Derived from `TRIGGER_PER_RUN_TIMEOUT_MS` — the ceiling a Trigger run
 * actually runs under (`runs/trigger-timeouts.ts`) — and NOT from the run
 * registry's generic 10-minute fallback, which Trigger runs never use: a
 * cutoff taken from it failed live runs at 15 minutes that were allowed 60.
 *
 * Horizontal scaling: the env var is read per process. Instances sharing a
 * database must be configured with the same value; one given a shorter value
 * computes an earlier cutoff and could fail a peer's live run.
 */
export function stuckTriggerCutoff(): Date {
  return staleCutoff(triggerPerRunTimeoutMs());
}

/**
 * The moment before which a `pending` Inbound Trigger run is considered
 * abandoned (ADR-0030): the stale buffer alone. A pending row has not started,
 * so no per-run timeout bounds it — its own process moves it to `running`
 * moments after accepting the call. One still pending past the buffer lost its
 * process in between, and it holds its record's dedup, so waiting the full
 * per-run timeout would answer that record's calls with a run that never
 * starts for an hour.
 */
export function stuckPendingTriggerCutoff(): Date {
  return staleCutoff(0);
}

/**
 * Periodic recovery for state left behind by a server crash mid-execution.
 *
 * Two failure modes:
 *
 * 1. `TriggerSink.onStart` writes a `trigger_run` row with status `running`.
 *    A crash leaves that row dangling, which clutters the UI and gives no
 *    indication the run failed. Its Run events (#647) dangle with it: whatever
 *    was open when the process died is still `running`, so the sweep closes
 *    them with the run's terminal status — as errors, with no duration, since
 *    nobody saw them end. The detail page renders that as an unknown duration
 *    rather than a bar drawn to "now".
 *
 * 2. A recurring cron Trigger with `nextRunAt = NULL` is invisible to the
 *    scheduler's `nextRunAt <= NOW()`, so it never fires again. The claim now
 *    writes the next schedule rather than NULL, but rows stranded by the old
 *    NULL claim remain, so every enabled recurring cron Trigger with a NULL
 *    `nextRunAt` and no `running` run is put back on its cadence. One with a
 *    `running` run is left alone; it is repaired once that run ends or is
 *    failed below.
 *
 * Critical horizontal-scaling note: a `running` row may still be a peer
 * instance's live work — a Trigger run executes in the process that started
 * it, outside the scheduler lock. We must NOT touch rows younger than
 * {@link stuckTriggerCutoff} (`TRIGGER_PER_RUN_TIMEOUT_MS` +
 * `RECOVERY_STALE_BUFFER_MS`), because a live instance would have aborted any
 * run older than that via its own per-run timeout. Recovery is gated on that
 * age threshold; the advisory lock only serializes concurrent recoveries, it
 * does not prevent racing live runs.
 */
export async function recoverStuckTriggers(): Promise<void> {
  const cutoff = stuckTriggerCutoff();

  // Mark abandoned runs as failed. The age cutoff guarantees no live peer is
  // still working on them. `pending` is included for Inbound Trigger runs
  // (ADR-0030): the row is written before the run starts, so a crash between
  // the two leaves it pending — and a pending row holds its record's dedup
  // slot, so it gets the shorter cutoff of a run that never started.
  const orphaned = await db
    .update(triggerRunTable)
    .set({
      status: "failed",
      errorMessage: "Server restarted during execution",
      completedAt: new Date(),
    })
    .where(
      or(
        and(
          eq(triggerRunTable.status, "running"),
          lt(triggerRunTable.startedAt, cutoff),
        ),
        and(
          eq(triggerRunTable.status, "pending"),
          lt(triggerRunTable.startedAt, stuckPendingTriggerCutoff()),
        ),
      ),
    )
    .returning({
      id: triggerRunTable.id,
      triggerId: triggerRunTable.triggerId,
    });

  if (orphaned.length > 0) {
    // No terminal run leaves an open event. The sweep is one of the two paths
    // that end a run without ending its events (cancellation is the other, and
    // the sink covers that one).
    await db
      .update(triggerRunEventTable)
      .set({ status: "error" })
      .where(
        and(
          inArray(
            triggerRunEventTable.runId,
            orphaned.map((r) => r.id),
          ),
          eq(triggerRunEventTable.status, "running"),
        ),
      );

    logger.warn(
      { count: orphaned.length, cutoff: cutoff.toISOString() },
      "Marked orphaned trigger runs as failed (older than per-run timeout)",
    );
  }

  const unscheduled = and(
    eq(triggerTable.type, "cron"),
    eq(triggerTable.enabled, true),
    isNull(triggerTable.nextRunAt),
    not(hasRunningRun),
  );
  const stuck = await db.select().from(triggerTable).where(unscheduled);

  for (const job of stuck) {
    const config = cronConfigOrNull(job);
    if (!config || config.isOneOff) continue;
    const nextRunAt = nextCronRunAt(config);
    if (!nextRunAt) {
      logger.error(
        { triggerId: job.id, cronExpression: config.cronExpression },
        "Failed to recompute nextRunAt during recovery (invalid cron expression?)",
      );
      continue;
    }
    await db
      .update(triggerTable)
      .set({ nextRunAt, updatedAt: new Date() })
      .where(and(eq(triggerTable.id, job.id), unscheduled));
    logger.warn(
      {
        triggerId: job.id,
        name: job.name,
        nextRunAt: nextRunAt.toISOString(),
      },
      "Recovered cron trigger with NULL nextRunAt",
    );
  }
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
 * A Chat is orphaned when its run heartbeat has gone stale
 * (`runs/chat-run-heartbeat.ts`, #1297): the instance holding a run stamps it
 * every few seconds, so one not stamped for a minute has no live owner on any
 * instance, whatever the Chat per-run timeout. A row with no stamp yet is
 * judged on `lastTurnAt`, then `updatedAt`.
 *
 * Same horizontal-scaling reasoning as `recoverStuckTriggers`: the age cutoff
 * is what makes this safe against a peer's live work; the advisory lock only
 * serializes concurrent sweeps.
 *
 * The status written is `failed`, not `cancelled` — nobody requested a
 * cancellation, and reporting one would misdescribe the event.
 */
export async function recoverStuckChats(): Promise<void> {
  const cutoff = runHeartbeatCutoff();

  const orphaned = await db
    .update(chatTable)
    .set({ status: "failed", updatedAt: new Date() })
    .where(and(eq(chatTable.status, "running"), chatRunStale(cutoff)))
    .returning({ id: chatTable.id });

  if (orphaned.length === 0) return;

  logger.warn(
    { count: orphaned.length, cutoff: cutoff.toISOString() },
    "Marked orphaned Chats as failed (their run's heartbeat went stale)",
  );
  // Their runs died with an instance, so no run's end records or pushes their
  // Tasks. Not awaited: this runs under the scheduler's lock, and a slow
  // client URL must not hold up due Triggers.
  for (const { id } of orphaned) {
    void onA2aTurnEnded({ chatId: id, status: "failed" });
  }
}

/**
 * How often the Inbound Trigger and A2A token reminders are swept. Their
 * thresholds are days, so the scheduler's every-minute tick would only repeat a query
 * that finds nothing new; hourly keeps a reminder at most an hour late.
 */
const TOKEN_REMINDER_INTERVAL_MS = 60 * 60 * 1000;

/**
 * When this process last finished a reminder sweep. Per process: each claim
 * is conditional, so a peer sweeping too never repeats a reminder.
 */
let lastTokenReminderSweepAt: number | null = null;

/**
 * The reminder sweep, when it is due. A sweep that throws is not recorded, so
 * the next tick tries again rather than waiting out the interval.
 */
export async function sweepTokenRemindersIfDue(
  now: number = Date.now(),
): Promise<void> {
  if (
    lastTokenReminderSweepAt !== null &&
    now - lastTokenReminderSweepAt < TOKEN_REMINDER_INTERVAL_MS
  ) {
    return;
  }
  await sendInboundTokenReminders(new Date(now));
  await sendA2aTokenReminders(new Date(now));
  lastTokenReminderSweepAt = now;
}

/** Test seam: forget when the reminders were last swept. */
export function resetTokenReminderSweep(): void {
  lastTokenReminderSweepAt = null;
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
  scheduleAligned("trigger-scheduler", SCHEDULER_INTERVAL_MS, async () => {
    await runWithLock(ADVISORY_LOCK_IDS.scheduler, async () => {
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
      // Never throws; after the Chat sweep, so a Task it just failed is seen.
      await pushMissedA2aEnds();
      try {
        await sweepTokenRemindersIfDue();
      } catch (error) {
        logger.error({ error }, "Token expiry reminders failed");
      }
      await processDueTriggers();
    });
  });
}
