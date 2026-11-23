import {
  and,
  asc,
  count,
  eq,
  isNotNull,
  lte,
  not,
  inArray,
  sql,
} from "drizzle-orm";
import type { CronTriggerConfig } from "@platypus/schemas";
import { db } from "../index.ts";
import {
  a2aTask as a2aTaskTable,
  chat as chatTable,
  trigger as triggerTable,
  triggerRun as triggerRunTable,
  workspace as workspaceTable,
} from "../db/schema.ts";
import { fireTrigger } from "../services/trigger-firing.ts";
import {
  deleteTriggerRunFiles,
  type TriggerRunScope,
} from "../services/trigger-run-files.ts";
import {
  failAbandonedTriggerRuns,
  liveTriggerRun,
} from "../services/trigger-run-lifecycle.ts";
import { sendInboundTokenReminders } from "../services/inbound-trigger.ts";
import { sendA2aTokenReminders } from "../services/a2a-token.ts";
import { DAY_MS } from "../services/bearer-token.ts";
import {
  FIRED_ONE_OFF_TTL_DAYS,
  narrowTriggerConfig,
  nextCronRunAt,
  type TriggerRow,
} from "../services/trigger.ts";
import { logger } from "../logger.ts";
import { ADVISORY_LOCK_IDS, withAdvisoryLock } from "../db/advisory-lock.ts";
import {
  chatRunStale,
  runHeartbeatCutoff,
} from "../runs/chat-run-heartbeat.ts";
import { triggerPerRunTimeoutMs } from "../runs/trigger-timeouts.ts";
import { sweepMissedEnds, turnEnded } from "../services/a2a-task-lifecycle.ts";
import { env } from "../env.ts";
import { oneRow } from "../db/one-row.ts";

export function scheduleAligned(
  name: string,
  intervalMs: number,
  fn: () => Promise<void>,
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  function scheduleNext() {
    const now = Date.now();
    const nextTick = (Math.floor(now / intervalMs) + 1) * intervalMs;
    const delay = nextTick - now;

    timer = setTimeout(() => {
      timer = undefined;
      void (async () => {
        if (stopped) return;
        try {
          await fn();
        } catch (error) {
          logger.error({ error, job: name }, "Scheduled job failed");
        }
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- set by the returned stop callback during the await, which TS narrowing does not track
        if (!stopped) scheduleNext();
      })();
    }, delay);
  }

  scheduleNext();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
}

const hasRunningRun = sql`exists (select 1 from ${triggerRunTable} where ${triggerRunTable.triggerId} = ${triggerTable.id} and ${triggerRunTable.status} = 'running')`;

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

export async function processDueTriggers(): Promise<void> {
  const now = new Date();

  const { running } = oneRow(
    await db
      .select({ running: count() })
      .from(triggerRunTable)
      .innerJoin(triggerTable, eq(triggerTable.id, triggerRunTable.triggerId))
      .where(
        and(
          eq(triggerRunTable.status, "running"),
          eq(triggerTable.type, "cron"),
        ),
      ),
  );
  let slots = env().SCHEDULE_MAX_CONCURRENT - running;

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
            ? { enabled: false, nextRunAt: null, firedAt: now, updatedAt: now }
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

const RECOVERY_STALE_BUFFER_MS = 5 * 60 * 1000;

function staleCutoff(perRunTimeoutMs: number): Date {
  return new Date(Date.now() - (perRunTimeoutMs + RECOVERY_STALE_BUFFER_MS));
}

export function stuckTriggerCutoff(): Date {
  return staleCutoff(triggerPerRunTimeoutMs());
}

export function stuckPendingTriggerCutoff(): Date {
  return staleCutoff(0);
}

export async function recoverStuckTriggers(): Promise<void> {
  await failAbandonedTriggerRuns({
    runningCutoff: stuckTriggerCutoff(),
    pendingCutoff: stuckPendingTriggerCutoff(),
  });
}

export async function reapFiredOneOffTriggers(): Promise<void> {
  const cutoff = new Date(Date.now() - FIRED_ONE_OFF_TTL_DAYS * DAY_MS);
  const expired = and(
    isNotNull(triggerTable.firedAt),
    sql`not exists (select 1 from ${triggerRunTable} where ${triggerRunTable.triggerId} = ${triggerTable.id} and ${liveTriggerRun()})`,
    sql`coalesce((select max(${triggerRunTable.completedAt}) from ${triggerRunTable} where ${triggerRunTable.triggerId} = ${triggerTable.id}), ${triggerTable.firedAt}) < ${cutoff}`,
  );

  const reaped = await db.transaction(async (tx) => {
    const expiring = await tx
      .select({
        triggerId: triggerTable.id,
        runId: triggerRunTable.id,
        orgId: workspaceTable.organizationId,
        workspaceId: triggerTable.workspaceId,
      })
      .from(triggerTable)
      .leftJoin(workspaceTable, eq(workspaceTable.id, triggerTable.workspaceId))
      .leftJoin(triggerRunTable, eq(triggerRunTable.triggerId, triggerTable.id))
      .where(expired);
    if (expiring.length === 0) return [];

    const deleted = await tx
      .delete(triggerTable)
      .where(
        and(
          expired,
          inArray(triggerTable.id, [
            ...new Set(expiring.map(({ triggerId }) => triggerId)),
          ]),
        ),
      )
      .returning({ id: triggerTable.id });
    const deletedIds = new Set(deleted.map(({ id }) => id));
    return expiring.filter(({ triggerId }) => deletedIds.has(triggerId));
  });

  if (reaped.length === 0) return;

  const runsByScope = new Map<
    string,
    { scope: TriggerRunScope; runIds: string[] }
  >();
  for (const { runId, orgId, workspaceId } of reaped) {
    if (!runId || !orgId) continue;
    const key = `${orgId}/${workspaceId}`;
    const group = runsByScope.get(key) ?? {
      scope: { orgId, workspaceId },
      runIds: [],
    };
    group.runIds.push(runId);
    runsByScope.set(key, group);
  }
  await Promise.all(
    [...runsByScope.values()].map(({ scope, runIds }) =>
      deleteTriggerRunFiles(scope, runIds),
    ),
  );

  logger.info(
    { count: new Set(reaped.map(({ triggerId }) => triggerId)).size },
    "Reaped expired One-off Triggers",
  );
}

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
  const tasks = await db
    .select({ chatId: a2aTaskTable.chatId })
    .from(a2aTaskTable)
    .where(
      inArray(
        a2aTaskTable.chatId,
        orphaned.map(({ id }) => id),
      ),
    );
  for (const chatId of new Set(tasks.map((task) => task.chatId))) {
    void turnEnded({ chatId, status: "failed" });
  }
}

const TOKEN_REMINDER_INTERVAL_MS = 60 * 60 * 1000;

export function startScheduler(): () => void {
  const intervalMs = env().SCHEDULE_SCHEDULER_INTERVAL_MS;
  let lastTokenReminderSweepAt: number | null = null;

  async function sweepTokenRemindersIfDue(): Promise<void> {
    const now = Date.now();
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

  logger.info(
    `Starting scheduler (interval: ${intervalMs}ms, wall-clock aligned)`,
  );

  return scheduleAligned("trigger-scheduler", intervalMs, async () => {
    await withAdvisoryLock(
      db.$client,
      ADVISORY_LOCK_IDS.scheduler,
      async () => {
        try {
          await recoverStuckTriggers();
        } catch (error) {
          logger.error({ error }, "Trigger recovery sweep failed");
        }
        try {
          await reapFiredOneOffTriggers();
        } catch (error) {
          logger.error({ error }, "One-off Trigger reap failed");
        }
        try {
          await recoverStuckChats();
        } catch (error) {
          logger.error({ error }, "Chat recovery sweep failed");
        }
        await sweepMissedEnds();
        try {
          await sweepTokenRemindersIfDue();
        } catch (error) {
          logger.error({ error }, "Token expiry reminders failed");
        }
        await processDueTriggers();
      },
      { wait: false },
    );
  });
}
