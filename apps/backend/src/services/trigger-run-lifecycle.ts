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

export type { EndedTriggerRun } from "./trigger-run-announce.ts";

export const LIVE_TRIGGER_RUN_STATUSES: TriggerRunStatus[] = [
  "pending",
  "running",
];

export const liveTriggerRun = () =>
  inArray(triggerRunTable.status, LIVE_TRIGGER_RUN_STATUSES);

export const notLiveTriggerRun = () =>
  notInArray(triggerRunTable.status, LIVE_TRIGGER_RUN_STATUSES);

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
  entityId?: string;
  eventType?: EventTriggerEvent;
  eventData?: EventTriggerEventPayload["data"];
};

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

export type AcceptInboundTriggerRunInput = {
  runId: string;
  triggerId: string;
  entityId: string;
  inputs: Record<string, string>;
};

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

export const suppressTriggerRun = async (
  input: SuppressedTriggerRunInput,
): Promise<void> => {
  const suppressed = await recordSuppressedTriggerRun(db, {
    ...input,
    runId: nanoid(),
  });
  await triggerRunsEnded([suppressed]);
};

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

export const triggerRunStats = (stats: RunStats): TriggerRunStats | null => {
  if (stats.steps == null) return null;
  return {
    steps: stats.steps ?? 0,
    toolCalls: stats.toolCalls ?? [],
    inputTokens: stats.inputTokens ?? 0,
    outputTokens: stats.outputTokens ?? 0,
    ...(stats.contextOccupancy === undefined
      ? {}
      : { contextOccupancy: stats.contextOccupancy }),
    ...(stats.cacheReadTokens === undefined
      ? {}
      : { cacheReadTokens: stats.cacheReadTokens }),
    ...(stats.cacheWriteTokens === undefined
      ? {}
      : { cacheWriteTokens: stats.cacheWriteTokens }),
    ...(stats.truncatedByTokenLimit
      ? { truncatedByTokenLimit: true as const }
      : {}),
    ...(stats.stoppedAtStepLimit ? { stoppedAtStepLimit: true as const } : {}),
    ...(stats.usageByModel ? { usageByModel: stats.usageByModel } : {}),
    ...(stats.fallback ? { fallback: stats.fallback } : {}),
  };
};

export type EndTriggerRunInput = {
  runId: string;
  status: RunStatus;
  stats: RunStats;
  error?: Error;
  finalText?: string;
  eventsTruncated: boolean;
  failedToolCalls: number;
};

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

const ABANDONED_RUN_MESSAGE = "Server restarted during execution";

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

  void announceTriggerRunsEnded(abandoned);
};

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

const retainTriggerRunsFor = async (triggerId: string): Promise<void> => {
  const [current] = await db
    .select({
      maxRunsToKeep: triggerTable.maxRunsToKeep,
      workspaceId: triggerTable.workspaceId,
      orgId: workspaceTable.organizationId,
    })
    .from(triggerTable)
    .leftJoin(workspaceTable, eq(workspaceTable.id, triggerTable.workspaceId))
    .where(eq(triggerTable.id, triggerId))
    .limit(1);
  if (!current) return;
  await retainTriggerRuns(
    triggerId,
    current.maxRunsToKeep,
    current.orgId
      ? { orgId: current.orgId, workspaceId: current.workspaceId }
      : undefined,
  );
};

export const retainTriggerRuns = async (
  triggerId: string,
  maxRunsToKeep: number,
  scope?: TriggerRunScope,
): Promise<void> => {
  const { windowSeconds, suppressedRunsToKeep } = triggerBreakerConfig();
  let deletedCount = 0;
  const deletedRunIds: string[] = [];

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
      const since = new Date(Date.now() - windowSeconds * 1000);
      const removed = await db
        .delete(triggerRunTable)
        .where(
          and(
            eq(triggerRunTable.triggerId, triggerId),
            ne(triggerRunTable.status, "suppressed"),
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
