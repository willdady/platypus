import { and, eq, sql } from "drizzle-orm";
import { db } from "../../index.ts";
import {
  triggerRun as triggerRunTable,
  triggerRunEvent as triggerRunEventTable,
  workspace as workspaceTable,
} from "../../db/schema.ts";
import type {
  EventTriggerEvent,
  EventTriggerEventPayload,
} from "@platypus/schemas";
import { FlushScheduler } from "../flush-scheduler.ts";
import {
  adoptPendingTriggerRun,
  endTriggerRun,
  openTriggerRun,
  triggerRunStats,
} from "../../services/trigger-run-lifecycle.ts";
import { eventStatusForRun, type RunEventRecorder } from "../run-events.ts";
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
  workspaceId: string;
  ownerId: string;
  entityId?: string;
  eventType?: EventTriggerEvent;
  eventData?: EventTriggerEventPayload["data"];
  adoptPendingRow?: boolean;
  flushIntervalMs?: number;
};

export class TriggerSink implements RunSink {
  private latestStats: RunStats = {};
  private flusher?: FlushScheduler;
  private events?: RunEventRecorder;
  private runId = "";
  private readonly params: TriggerSinkParams;

  constructor(params: TriggerSinkParams) {
    this.params = params;
  }

  async onStart(ctx: {
    runId: RunId;
    messages: PlatypusUIMessage[];
    events?: RunEventRecorder;
  }): Promise<void> {
    this.runId = ctx.runId;
    this.events = ctx.events;
    await db.transaction(async (tx) => {
      const [owned] = await tx
        .select({ id: workspaceTable.id })
        .from(workspaceTable)
        .where(
          and(
            eq(workspaceTable.id, this.params.workspaceId),
            eq(workspaceTable.ownerId, this.params.ownerId),
          ),
        )
        .for("share");
      if (!owned) {
        throw new Error(
          `Workspace '${this.params.workspaceId}' no longer has the Owner this run acts as; trigger run '${ctx.runId}' not started`,
        );
      }
      if (this.params.adoptPendingRow) {
        await adoptPendingTriggerRun(tx, ctx.runId);
      } else {
        await openTriggerRun(tx, {
          runId: ctx.runId,
          triggerId: this.params.triggerId,
          entityId: this.params.entityId,
          eventType: this.params.eventType,
          eventData: this.params.eventData,
        });
      }
    });

    this.flusher = new FlushScheduler(
      () => this.flush(),
      this.params.flushIntervalMs,
    );
    this.events?.subscribe(() => this.flusher?.bump());
  }

  async onResolved(ctx: {
    runId: RunId;
    plan: ResolvedRunPlan;
  }): Promise<void> {
    const unloaded = ctx.plan.unloadedToolSets ?? [];
    if (unloaded.length === 0) return;
    await db
      .update(triggerRunTable)
      .set({ unloadedToolSets: [...unloaded] })
      .where(eq(triggerRunTable.id, ctx.runId));
  }

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
    finalText?: string;
  }): Promise<void> {
    await this.flusher?.dispose();
    this.flusher = undefined;

    this.events?.closeOpen(eventStatusForRun(ctx.status));
    await this.flushEvents();

    await endTriggerRun({
      runId: ctx.runId,
      status: ctx.status,
      stats: ctx.stats,
      error: ctx.error,
      finalText: ctx.finalText,
      eventsTruncated: this.events?.eventsTruncated ?? false,
      failedToolCalls: this.events?.failedToolCalls ?? 0,
    });
  }

  private async flush(): Promise<void> {
    const triggerStats = triggerRunStats(this.latestStats);
    const truncated = this.events?.eventsTruncated ?? false;
    const failedToolCalls = this.events?.failedToolCalls ?? 0;
    if (triggerStats != null || truncated || failedToolCalls > 0) {
      await db
        .update(triggerRunTable)
        .set({
          ...(triggerStats != null ? { stats: triggerStats } : {}),
          ...(truncated ? { eventsTruncated: true } : {}),
          ...(failedToolCalls > 0 ? { failedToolCalls } : {}),
        })
        .where(eq(triggerRunTable.id, this.runId));
    }
    await this.flushEvents();
  }

  private async flushEvents(): Promise<void> {
    const events = this.events;
    if (!events) return;
    const { inserts, updates } = events.drain();
    let insertsDone = inserts.length === 0;
    let patched = 0;
    try {
      if (!insertsDone) {
        await db
          .insert(triggerRunEventTable)
          .values(
            inserts.map((event) => ({
              id: event.id,
              runId: event.runId,
              parentEventId: event.parentEventId,
              seq: event.seq,
              type: event.type,
              toolName: event.toolName,
              startedAt: event.startedAt,
              durationMs: event.durationMs,
              status: event.status,
              error: event.error,
              modelSwitch: event.modelSwitch,
              childrenTruncated: event.childrenTruncated,
            })),
          )
          // why: a retried batch may have committed already; upsert, or its events duplicate or go stale
          .onConflictDoUpdate({
            target: triggerRunEventTable.id,
            set: {
              status: sql`excluded.status`,
              durationMs: sql`excluded.duration_ms`,
              error: sql`excluded.error`,
              childrenTruncated: sql`excluded.children_truncated`,
            },
          });
        insertsDone = true;
      }
      for (const patch of updates) {
        await db
          .update(triggerRunEventTable)
          .set({
            status: patch.status,
            durationMs: patch.durationMs,
            error: patch.error,
            childrenTruncated: patch.childrenTruncated,
          })
          .where(eq(triggerRunEventTable.id, patch.id));
        patched++;
      }
    } catch (error) {
      events.requeue({
        inserts: insertsDone ? [] : inserts,
        updates: updates.slice(patched),
      });
      throw error;
    }
  }
}
