import {
  and,
  desc,
  eq,
  inArray,
  lt,
  lte,
  ne,
  notInArray,
  or,
  type SQLWrapper,
} from "drizzle-orm";
import { nanoid } from "nanoid";
import { db, type Executor, type Tx } from "../index.ts";
import { oneRow } from "../db/one-row.ts";
import {
  trigger as triggerTable,
  triggerRun as triggerRunTable,
  triggerRunEvent as triggerRunEventTable,
  workspace as workspaceTable,
} from "../db/schema.ts";
import { logger } from "../logger.ts";
import { errorMessage } from "../utils/error-message.ts";
import {
  deleteTriggerRunFiles,
  deleteTriggerRunFilesForTrigger,
  type TriggerRunScope,
} from "./trigger-run-files.ts";
import { triggerBreakerConfig } from "./trigger-breaker.ts";
import {
  announceTriggerRunsEnded,
  endedTriggerRunColumns,
  type EndedTriggerRun,
} from "./trigger-run-announce.ts";
import type { RunStats, RunStatus } from "../runs/types.ts";
import type {
  EventTriggerEvent,
  EventTriggerEventPayload,
  TriggerRunStats,
  TriggerRunStatus,
} from "@platypus/schemas";

/** A run as the announcement reads it; callers pass rows back untouched. */
export type { EndedTriggerRun } from "./trigger-run-announce.ts";

/**
 * The Trigger run lifecycle: the one module that inserts a `trigger_run` row,
 * or writes its `status`, the way the A2A Task lifecycle
 * (`a2a-task-lifecycle.ts`, ADR-0034) owns every A2A Task end.
 *
 * Every terminal write is conditional on the row still being live, so a run
 * ends exactly once and a late writer changes nothing; the write hands back
 * only the rows it actually changed, and — once whatever transaction wrote it
 * has committed — those are announced as `trigger_run.*` Webhook events and
 * their Trigger's history is pruned. That is what makes "exactly one event,
 * and one failed-run Notification, per run that ends" true:
 * `announceTriggerRunsEnded`'s own guarantee rests on the caller, and here the
 * caller is always this module.
 *
 * Callers say what happened to a run. None of them shapes a terminal write,
 * restates the live-status guard, or announces or prunes by hand.
 *
 * A `suppressed` row records a firing the run-rate breaker dropped: no Agent
 * ever ran, so it carries no stats and no completion time, and the row is the
 * visible trace of the trip.
 */

// ------------------------------------------------------------------- live runs

/**
 * The statuses a run is live in: accepted and not yet ended. The one definition
 * of "live" every reader shares — the terminal guard, inbound dedup, retention,
 * the One-off reaper and the recovery sweep.
 */
export const LIVE_TRIGGER_RUN_STATUSES: TriggerRunStatus[] = [
  "pending",
  "running",
];

/** Matches the runs that have not ended: the guard a terminal write needs. */
export const liveTriggerRun = () =>
  inArray(triggerRunTable.status, LIVE_TRIGGER_RUN_STATUSES);

/** Matches the runs that have ended. */
export const notLiveTriggerRun = () =>
  notInArray(triggerRunTable.status, LIVE_TRIGGER_RUN_STATUSES);

// ------------------------------------------------------------------- opening

/** The columns every insert of a run row carries, and the moment it is written. */
const runRowValues = (input: {
  runId: string;
  triggerId: string;
  status: TriggerRunStatus;
  entityId: string | null;
  eventType: EventTriggerEvent | null;
  eventData:
    | EventTriggerEventPayload["data"]
    | { inputs: Record<string, string> }
    | null;
}) => {
  const now = new Date();
  return {
    id: input.runId,
    triggerId: input.triggerId,
    status: input.status,
    entityId: input.entityId,
    eventType: input.eventType,
    eventData: input.eventData,
    startedAt: now,
    createdAt: now,
  };
};

export type OpenTriggerRunInput = {
  runId: string;
  triggerId: string;
  /** The single entity the event named, when it named one. */
  entityId?: string;
  eventType?: EventTriggerEvent;
  eventData?: EventTriggerEventPayload["data"];
};

/**
 * Opens a run as `running`: a Cron or Event Trigger's, which had no row before
 * the run started. Runs in the caller's transaction, so it commits with
 * whatever else the start owes — the sink holds the Workspace's Owner lock in
 * the same one, which is what keeps a run from starting halfway through a
 * transfer (ADR-0035).
 */
export const openTriggerRun = async (
  tx: Tx,
  input: OpenTriggerRunInput,
): Promise<void> => {
  await tx.insert(triggerRunTable).values(
    runRowValues({
      runId: input.runId,
      triggerId: input.triggerId,
      status: "running",
      entityId: input.entityId ?? null,
      eventType: input.eventType ?? null,
      eventData: input.eventData ?? null,
    }),
  );
};

/**
 * Adopts an Inbound Trigger call's `pending` row as `running`. The run is the
 * one whose id the caller already holds (ADR-0030), and `startedAt` moves to
 * the real start so the duration excludes the wait for the Drive to pick it up.
 *
 * Only a row still `pending` is adopted: one the recovery sweep already failed,
 * or retention pruned, must not come back as a live run nobody's dedup or poll
 * can see. So this throws, failing the run before the Agent starts.
 */
export const adoptPendingTriggerRun = async (
  tx: Tx,
  runId: string,
): Promise<void> => {
  const adopted = await tx
    .update(triggerRunTable)
    .set({ status: "running", startedAt: new Date() })
    .where(
      and(eq(triggerRunTable.id, runId), eq(triggerRunTable.status, "pending")),
    )
    .returning({ id: triggerRunTable.id });
  if (adopted.length === 0) {
    throw new Error(
      `Inbound trigger run '${runId}' is no longer pending; not started`,
    );
  }
};

// ---------------------------------------------------------------- acceptance

export type AcceptInboundTriggerRunInput = {
  runId: string;
  triggerId: string;
  /** The record key's value, or the Trigger's own id when none is marked. */
  entityId: string;
  inputs: Record<string, string>;
};

/**
 * Accepts an Inbound Trigger call as a `pending` run, inside the caller's
 * transaction: the id the caller is answered with has to be real before the
 * response goes out (ADR-0030). Nothing is announced or pruned — a pending run
 * has not ended — so the commit owes the lifecycle nothing.
 */
export const acceptInboundTriggerRun = async (
  tx: Tx,
  input: AcceptInboundTriggerRunInput,
): Promise<void> => {
  await tx.insert(triggerRunTable).values(
    runRowValues({
      runId: input.runId,
      triggerId: input.triggerId,
      status: "pending",
      entityId: input.entityId,
      eventType: null,
      eventData: { inputs: input.inputs },
    }),
  );
};

export type SuppressedTriggerRunInput = {
  triggerId: string;
  entityId: string;
  eventType?: EventTriggerEvent | null;
  eventData?:
    | EventTriggerEventPayload["data"]
    | { inputs: Record<string, string> }
    | null;
};

/**
 * Records a suppressed firing. The one implementation both paths use: the Event
 * Trigger's, on `db`, and the Inbound Trigger's, inside the transaction that
 * serialised its record — hence `database`.
 *
 * Announces and prunes nothing: a row written in a transaction is not ended
 * until that transaction commits, so the caller settles it then, through
 * {@link triggerRunsEnded}.
 */
export const recordSuppressedTriggerRun = async (
  database: Executor,
  input: SuppressedTriggerRunInput & { runId: string },
): Promise<EndedTriggerRun> => {
  const suppressed = await database
    .insert(triggerRunTable)
    .values(
      runRowValues({
        runId: input.runId,
        triggerId: input.triggerId,
        status: "suppressed",
        entityId: input.entityId,
        eventType: input.eventType ?? null,
        eventData: input.eventData ?? null,
      }),
    )
    .returning(endedTriggerRunColumns);
  return oneRow(suppressed);
};

/**
 * `recordSuppressedTriggerRun` for a caller with no enclosing transaction — the
 * Event Trigger path — recorded, announced and pruned in one step.
 */
export const suppressTriggerRun = async (
  input: SuppressedTriggerRunInput,
): Promise<void> => {
  const suppressed = await recordSuppressedTriggerRun(db, {
    ...input,
    runId: nanoid(),
  });
  await triggerRunsEnded([suppressed]);
};

// -------------------------------------------------------------------- ending

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
 * A run's statistics as the row stores them, or `null` for a run that never
 * observed a step: writing "0 steps, 0 tokens" for it would read as a real
 * measurement.
 *
 * Shared with the sink, whose mid-run flushes write the same shape.
 */
export const triggerRunStats = (stats: RunStats): TriggerRunStats | null => {
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
    ...(stats.usageByModel ? { usageByModel: stats.usageByModel } : {}),
    ...(stats.fallback ? { fallback: stats.fallback } : {}),
  };
};

export type EndTriggerRunInput = {
  runId: string;
  /** The registered run's outcome; only `succeeded` is a success. */
  status: RunStatus;
  stats: RunStats;
  error?: Error;
  finalText?: string;
  /** The run's timeline hit its event ceiling. */
  eventsTruncated: boolean;
  /** How many of the run's tool calls ended in error (#1184). */
  failedToolCalls: number;
};

/**
 * Ends a run with the outcome its Drive reached, its statistics and what it
 * concluded. Only a live row is ended: one the recovery sweep already failed
 * keeps that outcome, and announces nothing a second time — the first terminal
 * write stands.
 */
export const endTriggerRun = async (
  input: EndTriggerRunInput,
): Promise<void> => {
  const ended = await db
    .update(triggerRunTable)
    .set({
      status: toTriggerRunStatus(input.status),
      errorMessage: input.error?.message ?? null,
      stats: triggerRunStats(input.stats),
      completedAt: new Date(),
      finalText: input.finalText ?? null,
      eventsTruncated: input.eventsTruncated,
      failedToolCalls: input.failedToolCalls,
    })
    .where(and(eq(triggerRunTable.id, input.runId), liveTriggerRun()))
    .returning(endedTriggerRunColumns);
  await triggerRunsEnded(ended);
};

/**
 * Ends an inbound run whose firing threw before its Drive adopted the row, so
 * the run id its caller holds reaches a terminal status instead of reading
 * `pending` until the recovery sweep. A row the Drive already adopted is left
 * alone: its sink wrote the real outcome, and announced it.
 *
 * Never rejects. The firing has already failed, and this is the cleanup after
 * it: a write that cannot be made is logged and the sweep picks the row up.
 */
export const failUnstartedTriggerRun = async (
  runId: string,
  error: unknown,
): Promise<void> => {
  try {
    const ended = await db
      .update(triggerRunTable)
      .set({
        status: "failed",
        errorMessage: errorMessage(error),
        completedAt: new Date(),
      })
      .where(
        and(
          eq(triggerRunTable.id, runId),
          eq(triggerRunTable.status, "pending"),
        ),
      )
      .returning(endedTriggerRunColumns);
    await triggerRunsEnded(ended);
  } catch (updateError) {
    logger.error(
      { runId, error: errorMessage(updateError) },
      "Failed to mark a pending inbound trigger run as failed",
    );
  }
};

/** What the sweep writes as the reason a run it failed never ended. */
const ABANDONED_RUN_MESSAGE = "Server restarted during execution";

/**
 * Fails the runs no process is driving any more, and closes their still-open
 * Run events as errors — with no duration, since nobody saw them end.
 *
 * Two age cutoffs, both the caller's to compute: a `running` row has no live
 * owner once its per-run timeout plus the recovery buffer has passed, and a
 * `pending` row — an Inbound call's, which never started — after the buffer
 * alone (ADR-0030). Retention is not applied: a blamed run is old by
 * definition, and its Trigger's history is pruned by the next run that ends.
 */
export const failAbandonedTriggerRuns = async ({
  runningCutoff,
  pendingCutoff,
}: {
  runningCutoff: Date;
  pendingCutoff: Date;
}): Promise<void> => {
  const abandoned = await db
    .update(triggerRunTable)
    .set({
      status: "failed",
      errorMessage: ABANDONED_RUN_MESSAGE,
      completedAt: new Date(),
    })
    .where(
      or(
        and(
          eq(triggerRunTable.status, "running"),
          lt(triggerRunTable.startedAt, runningCutoff),
        ),
        and(
          eq(triggerRunTable.status, "pending"),
          lt(triggerRunTable.startedAt, pendingCutoff),
        ),
      ),
    )
    .returning(endedTriggerRunColumns);

  if (abandoned.length === 0) return;

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
          abandoned.map((run) => run.runId),
        ),
        eq(triggerRunEventTable.status, "running"),
      ),
    );

  logger.warn(
    { count: abandoned.length, cutoff: runningCutoff.toISOString() },
    "Marked orphaned trigger runs as failed (older than per-run timeout)",
  );

  // One `trigger_run.failed` per row this update changed. The advisory lock
  // keeps two sweeps from racing; a late finish on a swept row writes and
  // announces nothing, because the terminal write matches only a live row.
  // Started, not awaited: this runs under the scheduler's lock, and a slow
  // failed-run Notification must not hold up due Triggers.
  //
  // Retention is deliberately not applied here: a run the sweep fails is old by
  // definition, and the Trigger's history is pruned by the next run that ends.
  void announceTriggerRunsEnded(abandoned);
};

/**
 * Ends every `pending` run of the Triggers `triggerIds` as `cancelled`, inside
 * the caller's transaction: an Inbound call accepted but not yet started must
 * not start as the Workspace's new Owner (ADR-0035). Returns the rows it
 * changed, for the caller to settle through {@link triggerRunsEnded} once its
 * transaction has committed.
 */
export const cancelPendingTriggerRuns = async (
  tx: Tx,
  triggerIds: SQLWrapper | readonly string[],
): Promise<EndedTriggerRun[]> => {
  return tx
    .update(triggerRunTable)
    .set({ status: "cancelled", completedAt: new Date() })
    .where(
      and(
        inArray(triggerRunTable.triggerId, triggerIds),
        eq(triggerRunTable.status, "pending"),
      ),
    )
    .returning(endedTriggerRunColumns);
};

/**
 * A run's end — or a suppression — has committed. Announces the runs it ended
 * and prunes their Trigger's history.
 *
 * Only for the rows a write actually changed, and only after the transaction
 * that wrote them commits: announcing from inside one would announce a run
 * whose transaction may still roll back, and announcing rows that did not
 * change would announce a run twice.
 *
 * Both halves are best-effort and never reject into the caller, as they always
 * were: a failed announcement is logged inside `announceTriggerRunsEnded`, and
 * a failed prune here. The announcement is started, not awaited, so a run's
 * end costs no more than it did before — delivery was always in-process and
 * off the run's path.
 */
export const triggerRunsEnded = async (
  ended: readonly EndedTriggerRun[],
): Promise<void> => {
  if (ended.length === 0) return;
  void announceTriggerRunsEnded([...ended]);
  for (const triggerId of new Set(ended.map((run) => run.triggerId))) {
    try {
      await retainTriggerRunsFor(triggerId);
    } catch (error) {
      logger.error(
        { triggerId, error: errorMessage(error) },
        "Failed to retain trigger runs",
      );
    }
  }
};

/**
 * {@link retainTriggerRuns} for a Trigger, reading the budget and the file
 * scope it needs from the row as it is now.
 */
const retainTriggerRunsFor = async (triggerId: string): Promise<void> => {
  const [current] = await db
    .select({
      maxRunsToKeep: triggerTable.maxRunsToKeep,
      workspaceId: triggerTable.workspaceId,
      orgId: workspaceTable.organizationId,
    })
    .from(triggerTable)
    // Left, not inner: a missing Workspace must not stop the prune. A present
    // one names the scope the run Chats' files sit under, sparing retention a
    // second lookup.
    .leftJoin(workspaceTable, eq(workspaceTable.id, triggerTable.workspaceId))
    .where(eq(triggerTable.id, triggerId))
    .limit(1);
  // The Trigger is gone, and its runs cascaded with it.
  if (!current) return;
  await retainTriggerRuns(
    triggerId,
    current.maxRunsToKeep,
    current.orgId
      ? { orgId: current.orgId, workspaceId: current.workspaceId }
      : undefined,
  );
};

/**
 * Retention for one Trigger's runs, applied after every run and every
 * suppression.
 *
 * Replaces the old "newest maxRunsToKeep rows" rule with a union, because the
 * breaker counts rows `maxRunsToKeep` may have deleted: a Trigger busier than
 * its retention budget would otherwise have its own history pruned out from
 * under the count, and at `maxRunsToKeep: 1` the ceiling could never trip.
 *
 * `keep = (newest maxRunsToKeep) ∪ (started_at within the breaker window)`
 *
 * Suppressed rows are budgeted separately: a runaway produces them fast, and
 * sharing `maxRunsToKeep` would evict the runs that explain the incident in
 * favour of the evidence of their own suppression.
 *
 * Exported for its own tests and the lifecycle's internals; no other module
 * prunes a Trigger's history.
 */
export const retainTriggerRuns = async (
  triggerId: string,
  maxRunsToKeep: number,
  scope?: TriggerRunScope,
): Promise<void> => {
  const { windowSeconds, suppressedRunsToKeep } = triggerBreakerConfig();
  let deletedCount = 0;
  // Only a normal run has a Chat, and so stored files: a suppressed row records
  // a firing that never started one (ADR-0044). Keep its deletion counted for
  // the log, but out of the prefix cleanup.
  const deletedRunIds: string[] = [];

  // Nothing to prune when the Trigger holds fewer than the budget: the newest
  // query returning a short page means it returned every normal row there is.
  if (maxRunsToKeep > 0) {
    const newest = await db
      .select({ id: triggerRunTable.id })
      .from(triggerRunTable)
      .where(
        and(
          eq(triggerRunTable.triggerId, triggerId),
          ne(triggerRunTable.status, "suppressed"),
        ),
      )
      .orderBy(desc(triggerRunTable.startedAt))
      .limit(maxRunsToKeep);

    if (newest.length >= maxRunsToKeep) {
      // The window half of the union is expressed as a predicate rather than
      // an id list: selecting every row inside the window would grow the
      // `notInArray` argument with the Trigger's throughput, on a query that
      // runs after every run. `startedAt` is NOT NULL, so `<= since` is the
      // exact complement of the `> since` the count uses.
      const since = new Date(Date.now() - windowSeconds * 1000);
      const removed = await db
        .delete(triggerRunTable)
        .where(
          and(
            eq(triggerRunTable.triggerId, triggerId),
            ne(triggerRunTable.status, "suppressed"),
            // A run still in flight is never pruned, however old: its row is
            // what its sink finishes and what an Inbound Trigger's dedup and
            // poll read (ADR-0030). A per-run timeout longer than the window
            // would otherwise delete a live run's row mid-run. The recovery
            // sweep fails an abandoned one, which then prunes normally.
            notLiveTriggerRun(),
            lte(triggerRunTable.startedAt, since),
            notInArray(
              triggerRunTable.id,
              newest.map((row) => row.id),
            ),
          ),
        )
        .returning({ id: triggerRunTable.id });
      deletedCount += removed.length;
      deletedRunIds.push(...removed.map(({ id }) => id));
    }
  }

  const suppressed = await db
    .select({ id: triggerRunTable.id })
    .from(triggerRunTable)
    .where(
      and(
        eq(triggerRunTable.triggerId, triggerId),
        eq(triggerRunTable.status, "suppressed"),
      ),
    )
    .orderBy(desc(triggerRunTable.startedAt))
    .limit(suppressedRunsToKeep);

  if (suppressed.length >= suppressedRunsToKeep) {
    const removedSuppressed = await db
      .delete(triggerRunTable)
      .where(
        and(
          eq(triggerRunTable.triggerId, triggerId),
          eq(triggerRunTable.status, "suppressed"),
          notInArray(
            triggerRunTable.id,
            suppressed.map((row) => row.id),
          ),
        ),
      )
      .returning({ id: triggerRunTable.id });
    deletedCount += removedSuppressed.length;
  }

  if (deletedCount > 0) {
    // The rows are gone; their run Chats cascade with them. Their stored files
    // sit under prefixes nothing else reaches, so clear those too.
    if (scope) {
      await deleteTriggerRunFiles(scope, deletedRunIds);
    } else {
      await deleteTriggerRunFilesForTrigger(triggerId, deletedRunIds);
    }

    logger.info(
      {
        triggerId,
        deletedCount,
        maxRunsToKeep,
        windowSeconds,
        suppressedRunsToKeep,
      },
      "Cleaned up old trigger runs",
    );
  }
};
