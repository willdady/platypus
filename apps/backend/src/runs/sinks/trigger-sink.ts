import { eq } from "drizzle-orm";
import { db } from "../../index.ts";
import {
  triggerRun as triggerRunTable,
  triggerRunEvent as triggerRunEventTable,
} from "../../db/schema.ts";
import type {
  TriggerRunStats,
  TriggerRunStatus,
  WebhookEvent,
} from "@platypus/schemas";
import { FlushScheduler } from "../flush-scheduler.ts";
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
  /**
   * The single entity the event named, when it named one. Stored on the run
   * row so the run-rate breaker can count runs per Trigger per entity; absent
   * for Cron runs and for events that name a set rather than one thing.
   */
  entityId?: string;
  eventType?: WebhookEvent;
  eventData?: unknown;
  /** Override the FlushScheduler interval. Defaults to 5 seconds. */
  flushIntervalMs?: number;
};

/** Default cadence for periodic TriggerSink stat and event flushes. */
const DEFAULT_FLUSH_INTERVAL_MS = 5_000;

/**
 * `steps == null` means no step was ever observed, and writing "0 steps, 0
 * tokens" for a run that never started reads as a real measurement — hence the
 * null.
 */
const toTriggerRunStats = (stats: RunStats): TriggerRunStats | null => {
  if (stats.steps == null) return null;
  return {
    steps: stats.steps ?? 0,
    toolCalls: stats.toolCalls ?? [],
    inputTokens: stats.inputTokens ?? 0,
    outputTokens: stats.outputTokens ?? 0,
    // Spread rather than defaulted to 0: unlike the sums above, an absent
    // occupancy means the Provider reported no usage, and writing 0 there would
    // record an empty context as a measurement (ADR-0018). The cached-token
    // breakdowns follow the same idiom — absent means the Provider reported no
    // cache detail, never a zero (issue #734).
    ...(stats.contextOccupancy === undefined
      ? {}
      : { contextOccupancy: stats.contextOccupancy }),
    ...(stats.cacheReadTokens === undefined
      ? {}
      : { cacheReadTokens: stats.cacheReadTokens }),
    ...(stats.cacheWriteTokens === undefined
      ? {}
      : { cacheWriteTokens: stats.cacheWriteTokens }),
    // Spread so an untruncated run stores no key at all, matching the schema's
    // `z.literal(true).optional()`.
    ...(stats.truncatedByTokenLimit
      ? { truncatedByTokenLimit: true as const }
      : {}),
    // Same idiom, same reason: a run whose loop was never stopped short stores
    // no key, so the flag's presence is the whole of its meaning.
    ...(stats.stoppedAtStepLimit ? { stoppedAtStepLimit: true as const } : {}),
  };
};

/** The run's status vocabulary, from the registered run's. */
const toTriggerRunStatus = (status: RunStatus): TriggerRunStatus => {
  switch (status) {
    case "succeeded":
      return "success";
    case "cancelled":
      return "cancelled";
    default:
      return "failed";
  }
};

/**
 * Persists `triggerRun` rows — and the run's **Run timeline** (#647) — around a
 * headless run.
 *
 * - `onStart`: INSERT row with status `running` and event metadata; takes the
 *   run's Run event recorder and starts flushing it.
 * - `onProgress`: drives a FlushScheduler that writes incremental `stats`
 *   (tool-call counts, step counts) so a long-running Trigger is observable on
 *   the runs page mid-flight. The recorder bumps the same scheduler, so events
 *   land on the same cadence: one multi-row insert of the events recorded since
 *   the last flush, plus a patch per event that has since closed. The write
 *   *rate* is bounded exactly as the stats flushing bounds it.
 * - `onFinish`: closes every still-open event with the run's terminal status
 *   and writes them, then UPDATEs the row with terminal status, final stats,
 *   error message and final text. Events first, so no reader ever sees a
 *   terminal run with a running event.
 *
 * `suppressed` rows are written by the run-rate breaker instead of a run, and
 * never pass through this sink.
 *
 * Note: trigger-table maintenance (`lastRunAt`, `nextRunAt`, retention) is
 * still owned by `updateTriggerAfterRun`, called by event-dispatch and the
 * cron scheduler after `executeTrigger` returns.
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
    await db.insert(triggerRunTable).values({
      id: ctx.runId,
      triggerId: this.params.triggerId,
      status: "running",
      entityId: this.params.entityId ?? null,
      eventType: this.params.eventType ?? null,
      eventData: this.params.eventData ?? null,
      startedAt: new Date(),
      createdAt: new Date(),
    });

    const intervalMs = this.params.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.flusher = new FlushScheduler(intervalMs, () => this.flush());
    this.events?.subscribe(() => this.flusher?.bump());
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
    finalText?: string;
  }): Promise<void> {
    await this.flusher?.dispose();
    this.flusher = undefined;

    // Whatever was still open ends with the run — a cancelled tool call as
    // cancelled, a timed-out one as an error — and lands before the row flips.
    this.events?.closeOpen(eventStatusForRun(ctx.status));
    await this.flushEvents();

    const triggerStats = toTriggerRunStats(ctx.stats);

    await db
      .update(triggerRunTable)
      .set({
        status: toTriggerRunStatus(ctx.status),
        errorMessage: ctx.error?.message ?? null,
        stats: triggerStats,
        completedAt: new Date(),
        finalText: ctx.finalText ?? null,
        eventsTruncated: this.events?.eventsTruncated ?? false,
      })
      .where(eq(triggerRunTable.id, ctx.runId));
  }

  /**
   * One scheduled flush: the latest stats — and the run's truncation marker
   * the moment the ceiling is hit, so a reader polling mid-run sees the run
   * marked, not only the node — then the events since the last flush.
   */
  private async flush(): Promise<void> {
    const triggerStats = toTriggerRunStats(this.latestStats);
    const truncated = this.events?.eventsTruncated ?? false;
    if (triggerStats != null || truncated) {
      await db
        .update(triggerRunTable)
        .set({
          ...(triggerStats != null ? { stats: triggerStats } : {}),
          ...(truncated ? { eventsTruncated: true } : {}),
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
   */
  private async flushEvents(): Promise<void> {
    if (!this.events) return;
    const { inserts, updates } = this.events.drain();
    if (inserts.length > 0) {
      await db.insert(triggerRunEventTable).values(
        inserts.map((event) => ({
          id: event.id,
          runId: event.runId,
          parentEventId: event.parentEventId,
          seq: event.seq,
          type: event.type,
          toolName: event.toolName ?? null,
          startedAt: event.startedAt,
          durationMs: event.durationMs ?? null,
          status: event.status,
          error: event.error ?? null,
          childrenTruncated: event.childrenTruncated ?? false,
        })),
      );
    }
    for (const patch of updates) {
      await db
        .update(triggerRunEventTable)
        .set({
          status: patch.status,
          durationMs: patch.durationMs ?? null,
          error: patch.error ?? null,
          childrenTruncated: patch.childrenTruncated ?? false,
        })
        .where(eq(triggerRunEventTable.id, patch.id));
    }
  }
}
