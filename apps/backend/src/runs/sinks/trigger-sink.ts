import { eq } from "drizzle-orm";
import { db } from "../../index.ts";
import { triggerRun as triggerRunTable } from "../../db/schema.ts";
import type { TriggerRunStats, WebhookEvent } from "@platypus/schemas";
import { FlushScheduler } from "../flush-scheduler.ts";
import type {
  ResolvedRunPlan,
  RunId,
  RunSink,
  RunStats,
  RunStatus,
} from "../types.ts";
import type { PlatypusUIMessage } from "../../types.ts";

export type TriggerSinkParams = {
  triggerId: string;
  eventType?: WebhookEvent;
  eventData?: unknown;
  /** Override the FlushScheduler interval. Defaults to 5 seconds. */
  flushIntervalMs?: number;
};

/** Default cadence for periodic TriggerSink stat flushes. */
export const DEFAULT_FLUSH_INTERVAL_MS = 5_000;

const toTriggerRunStats = (stats: RunStats): TriggerRunStats | null => {
  if (stats.steps == null) return null;
  return {
    steps: stats.steps ?? 0,
    toolCalls: stats.toolCalls ?? [],
    inputTokens: stats.inputTokens ?? 0,
    outputTokens: stats.outputTokens ?? 0,
  };
};

/**
 * Persists `triggerRun` rows around a headless run.
 *
 * - `onStart`: INSERT row with status `running` and event metadata.
 * - `onProgress`: drives a FlushScheduler that writes incremental
 *   `stats` (tool-call counts, step counts) so a long-running Trigger
 *   is observable on the runs page mid-flight.
 * - `onFinish`: UPDATE row with terminal status, final stats, error message.
 *
 * The `triggerRun` schema's status enum is `running | success | failed`,
 * so cancelled runs are mapped to `failed`. Adding a `cancelled` value is
 * deferred to a follow-up.
 *
 * Note: trigger-table maintenance (`lastRunAt`, `nextRunAt`, retention) is
 * still owned by `updateTriggerAfterRun`, called by event-dispatch and the
 * cron scheduler after `executeTrigger` returns.
 */
export class TriggerSink implements RunSink {
  private latestStats: RunStats = {};
  private flusher?: FlushScheduler;
  private runId = "";
  private readonly params: TriggerSinkParams;

  constructor(params: TriggerSinkParams) {
    this.params = params;
  }

  async onStart(ctx: {
    runId: RunId;
    messages: PlatypusUIMessage[];
  }): Promise<void> {
    this.runId = ctx.runId;
    await db.insert(triggerRunTable).values({
      id: ctx.runId,
      triggerId: this.params.triggerId,
      status: "running",
      eventType: this.params.eventType ?? null,
      eventData: this.params.eventData ?? null,
      startedAt: new Date(),
      createdAt: new Date(),
    });

    const intervalMs = this.params.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.flusher = new FlushScheduler(intervalMs, async () => {
      const triggerStats = toTriggerRunStats(this.latestStats);
      if (triggerStats == null) return;
      await db
        .update(triggerRunTable)
        .set({ stats: triggerStats })
        .where(eq(triggerRunTable.id, this.runId));
    });
  }

  async onResolved(_: { runId: RunId; plan: ResolvedRunPlan }): Promise<void> {
    // No-op: row was inserted in onStart and the plan adds no fields the
    // triggerRun schema persists today.
  }

  // Synchronous work; returns a resolved promise to satisfy the async RunSink contract.
  onProgress(ctx: {
    runId: RunId;
    messages: PlatypusUIMessage[];
    stats: RunStats;
  }): Promise<void> {
    this.latestStats = ctx.stats;
    this.flusher?.bump();
    return Promise.resolve();
  }

  async onFinish(ctx: {
    runId: RunId;
    status: RunStatus;
    messages: PlatypusUIMessage[];
    stats: RunStats;
    error?: Error;
  }): Promise<void> {
    await this.flusher?.dispose();
    this.flusher = undefined;

    const status = ctx.status === "succeeded" ? "success" : "failed";
    const triggerStats = toTriggerRunStats(ctx.stats);

    await db
      .update(triggerRunTable)
      .set({
        status,
        errorMessage: ctx.error?.message ?? null,
        stats: triggerStats,
        completedAt: new Date(),
      })
      .where(eq(triggerRunTable.id, ctx.runId));
  }
}
