import { eq } from "drizzle-orm";
import { db } from "../../index.ts";
import { triggerRun as triggerRunTable } from "../../db/schema.ts";
import type { TriggerRunStats, WebhookEvent } from "@platypus/schemas";
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
};

/**
 * Persists `triggerRun` rows around a headless run.
 *
 * - `onStart`: INSERT row with status `running` and event metadata.
 * - `onProgress`: no-op for PR #2 (write-through stats arrives in PR #3).
 * - `onFinish`: UPDATE row with terminal status, stats, error message.
 *
 * Note: trigger-table maintenance (`lastRunAt`, `nextRunAt`, retention) is
 * still owned by `updateTriggerAfterRun`, called by event-dispatch and the
 * cron scheduler after `executeTrigger` returns.
 */
export class TriggerSink implements RunSink {
  constructor(private readonly params: TriggerSinkParams) {}

  async onStart(ctx: { runId: RunId }): Promise<void> {
    await db.insert(triggerRunTable).values({
      id: ctx.runId,
      triggerId: this.params.triggerId,
      status: "running",
      eventType: this.params.eventType ?? null,
      eventData: this.params.eventData ?? null,
      startedAt: new Date(),
      createdAt: new Date(),
    });
  }

  async onResolved(_: { runId: RunId; plan: ResolvedRunPlan }): Promise<void> {
    // No-op: trigger row was already inserted in onStart and the plan adds
    // no fields the triggerRun schema persists today.
  }

  async onProgress(_: {
    runId: RunId;
    messages: PlatypusUIMessage[];
    stats: RunStats;
  }): Promise<void> {
    // No-op for PR #2.
  }

  async onFinish(ctx: {
    runId: RunId;
    status: RunStatus;
    messages: PlatypusUIMessage[];
    stats: RunStats;
    error?: Error;
  }): Promise<void> {
    const status = ctx.status === "succeeded" ? "success" : "failed";
    const triggerStats: TriggerRunStats | null =
      ctx.stats.steps != null
        ? {
            steps: ctx.stats.steps ?? 0,
            toolCalls: ctx.stats.toolCalls ?? [],
            inputTokens: ctx.stats.inputTokens ?? 0,
            outputTokens: ctx.stats.outputTokens ?? 0,
          }
        : null;

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
