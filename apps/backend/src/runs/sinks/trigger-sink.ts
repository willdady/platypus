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
  /** The Owner the run was resolved to act as; it starts only while they still are. */
  ownerId: string;
  /**
   * The single entity the event named, when it named one. Stored on the run
   * row so the run-rate breaker can count runs per Trigger per entity; absent
   * for Cron runs and for events that name a set rather than one thing.
   */
  entityId?: string;
  eventType?: EventTriggerEvent;
  eventData?: EventTriggerEventPayload["data"];
  /**
   * The run's row already exists as `pending` — an Inbound Trigger call wrote
   * it before answering, so the run id it returned is real (ADR-0030). The
   * start then adopts that row instead of inserting one.
   */
  adoptPendingRow?: boolean;
  /** Override the FlushScheduler interval. Defaults to 5 seconds. */
  flushIntervalMs?: number;
};

/**
 * Persists `triggerRun` rows — and the run's **Run timeline** (#647) — around a
 * headless run. Every write of the run's `status` belongs to the Trigger run
 * lifecycle (`services/trigger-run-lifecycle.ts`); this sink says what happened
 * to the run and writes only what does not touch status.
 *
 * - `onStart`: opens the run as `running` with its event metadata — or, for an
 *   inbound run, has its `pending` row adopted; takes the run's Run event
 *   recorder and starts flushing it.
 * - `onProgress`: drives a FlushScheduler that writes incremental `stats`
 *   (tool-call counts, step counts) so a long-running Trigger is observable on
 *   the runs page mid-flight. The recorder bumps the same scheduler, so events
 *   land on the same cadence: one multi-row insert of the events recorded since
 *   the last flush, plus a patch per event that has since closed. The write
 *   *rate* is bounded exactly as the stats flushing bounds it.
 * - `onFinish`: closes every still-open event with the run's terminal status
 *   and writes them, then hands the run's outcome to the lifecycle, which ends
 *   the row and announces it. Events first, so no reader ever sees a terminal
 *   run with a running event.
 *
 * `suppressed` rows are recorded by the lifecycle, in place of the run the
 * breaker dropped, and never pass through this sink.
 *
 * Note: trigger-table maintenance (`lastRunAt`, `nextRunAt`) and run retention
 * are not this sink's: `services/trigger-firing.ts` owns the former and applies
 * it on every exit of a firing — including a run that threw before or after
 * this sink saw it — and the lifecycle applies retention as a run ends. The run
 * is bounded by `TRIGGER_PER_RUN_TIMEOUT_MS` (`runs/trigger-timeouts.ts`), not
 * the run registry's generic default; the stuck-run sweep in
 * `jobs/scheduler.ts` reads the same value, which is why a row this sink leaves
 * `running` is safe from it until that ceiling passes.
 */
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
      // A Workspace transfer holds this row while it lists the runs to cancel,
      // so a run either starts before and is cancelled with them, or waits and
      // finds a new Owner it was not resolved to act as (ADR-0035).
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
        // Throws when the row is no longer `pending`: failing the run before
        // the Agent starts is the point.
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

  /**
   * Records the Agent's Tool sets that loaded no tools (#1184) — before the
   * model is called, so a run that fails on its first step still has them.
   * A run whose every Tool set loaded writes nothing: the column's default
   * already says so.
   */
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
    finalText?: string;
  }): Promise<void> {
    await this.flusher?.dispose();
    this.flusher = undefined;

    // Whatever was still open ends with the run — a cancelled tool call as
    // cancelled, a timed-out one as an error — and lands before the row flips.
    this.events?.closeOpen(eventStatusForRun(ctx.status));
    await this.flushEvents();

    // The lifecycle ends the row only while it is still live: one the recovery
    // sweep already failed keeps that outcome, and announces nothing a second
    // time. The instance whose write lands is the one that announces the run.
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

  /**
   * One scheduled flush: the latest stats — and the run's truncation marker
   * the moment the ceiling is hit, so a reader polling mid-run sees the run
   * marked, not only the node — then the events since the last flush.
   */
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

  /**
   * Events never written go in one multi-row insert, in their current state;
   * events written earlier that have since changed are patched one by one. Both
   * are appends or single-row updates — never a rewrite of the timeline — which
   * is what lets parallel Sub-Agents record into one run without losing each
   * other's rows.
   *
   * A write that throws hands what it did not write back to the recorder, so
   * the next flush retries it rather than the batch being lost (#1124). An
   * insert whose first attempt committed before the error surfaced is retried
   * as an upsert of the event's current state, so the row is neither
   * duplicated nor left stale.
   */
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
