import { eq, inArray } from "drizzle-orm";
import { db } from "../index.ts";
import {
  trigger as triggerTable,
  triggerRun as triggerRunTable,
  workspace as workspaceTable,
} from "../db/schema.ts";
import { logger } from "../logger.ts";
import { errorMessage } from "../utils/error-message.ts";
import { dispatchWebhookEvent } from "./event-dispatch.ts";
import { createPlatypusNotification } from "./notification.ts";
import type {
  ModelSwitch,
  TriggerRunStats,
  TriggerRunWebhookEventPayload,
  TriggerType,
  UnloadedToolSet,
} from "@platypus/schemas";

/**
 * The columns a terminal write returns so its run can be announced. Taken from
 * the write itself rather than re-read afterwards, so a run retention prunes in
 * the meantime is still announced as a Webhook event; its Notification is lost,
 * because the row references the run and the insert then fails.
 */
export const endedTriggerRunColumns = {
  runId: triggerRunTable.id,
  triggerId: triggerRunTable.triggerId,
  status: triggerRunTable.status,
  startedAt: triggerRunTable.startedAt,
  completedAt: triggerRunTable.completedAt,
  errorMessage: triggerRunTable.errorMessage,
  eventType: triggerRunTable.eventType,
  entityId: triggerRunTable.entityId,
  unloadedToolSets: triggerRunTable.unloadedToolSets,
  failedToolCalls: triggerRunTable.failedToolCalls,
  stats: triggerRunTable.stats,
};

export type EndedTriggerRun = {
  runId: string;
  triggerId: string;
  status: string;
  startedAt: Date;
  completedAt: Date | null;
  errorMessage: string | null;
  eventType: string | null;
  entityId: string | null;
  unloadedToolSets: UnloadedToolSet[];
  failedToolCalls: number;
  /** The run's stats, for the Fallback marker carried on its terminal event. */
  stats?: TriggerRunStats | null;
};

type TriggerCoordinates = {
  name: string;
  type: TriggerType;
  agentId: string;
};

/** A Trigger row as the announcement reads it, joined to its Workspace. */
type AnnouncedTrigger = TriggerCoordinates & {
  id: string;
  workspaceId: string;
  organizationId: string;
};

/** A run's terminal event, or `null` for a status that is not terminal. */
const terminalEvent = (
  run: EndedTriggerRun,
  trigger: AnnouncedTrigger,
): TriggerRunWebhookEventPayload | null => {
  // Every field is on the wire, an empty one as `null` rather than absent —
  // except the Fallback marker, which is an added optional field and is
  // omitted entirely on a run that never switched (ADR-0043).
  const fallback: ModelSwitch | undefined = run.stats?.fallback;
  const fields = {
    runId: run.runId,
    startedAt: run.startedAt,
    completedAt: run.completedAt ?? null,
    errorMessage: run.errorMessage ?? null,
    triggerId: trigger.id,
    triggerName: trigger.name,
    triggerType: trigger.type,
    agentId: trigger.agentId,
    eventType: run.eventType ?? null,
    entityId: run.entityId ?? null,
    unloadedToolSets: run.unloadedToolSets,
    failedToolCalls: run.failedToolCalls,
    ...(fallback ? { fallback } : {}),
  };
  switch (run.status) {
    case "success":
      return {
        event: "trigger_run.succeeded",
        data: { ...fields, status: "success" },
      };
    case "failed":
      return {
        event: "trigger_run.failed",
        data: { ...fields, status: "failed" },
      };
    case "cancelled":
      return {
        event: "trigger_run.cancelled",
        data: { ...fields, status: "cancelled" },
      };
    case "suppressed":
      return {
        event: "trigger_run.suppressed",
        data: { ...fields, status: "suppressed" },
      };
    default:
      return null;
  }
};

/**
 * Posts the Workspace bell's notice that a Trigger run failed. Written by
 * Platypus rather than the Agent (`agentId: null`) and linked to the run, so
 * the bell reads "Platypus" and **Open** reaches the run.
 */
const postFailedRunNotification = async (
  run: EndedTriggerRun,
  trigger: AnnouncedTrigger,
): Promise<void> => {
  const reason = run.errorMessage?.trim() ?? "";
  await createPlatypusNotification(db, {
    workspaceId: trigger.workspaceId,
    title: `Trigger run failed: ${trigger.name}`,
    body: reason === "" ? "The run failed without an error message." : reason,
    sourceTriggerRunId: run.runId,
  });
};

/**
 * Announces Trigger runs that have just reached a terminal status, as
 * `trigger_run.*` Webhook events, and posts a Notification to the Trigger's
 * Workspace when a run ends `failed`.
 *
 * Exactly one event — and one Notification — per run rests on the caller: pass
 * only the rows a terminal write actually changed — a write conditional on the
 * row still being live, or the insert of a `suppressed` row — so whichever
 * instance won the write is the only one that announces. Delivery is
 * in-process, never over the cross-instance channel. Its one caller is the
 * Trigger run lifecycle (`trigger-run-lifecycle.ts`), which is what keeps that
 * guarantee true across every path that ends a run.
 *
 * What is announced is the run's final status, not the first Provider error it
 * saw: a run that recovers (through the Fallback model or otherwise) and ends
 * `success` posts nothing.
 *
 * A run whose Trigger has since been deleted announces nothing. Never rejects:
 * a failed lookup is logged and the events are lost, and a failed Notification
 * insert is logged on its own without dropping the run's Webhook event, as both
 * are best-effort.
 */
export const announceTriggerRunsEnded = async (
  runs: EndedTriggerRun[],
): Promise<void> => {
  if (runs.length === 0) return;
  try {
    const triggerIds = [...new Set(runs.map((run) => run.triggerId))];
    const triggers = await db
      .select({
        id: triggerTable.id,
        name: triggerTable.name,
        type: triggerTable.type,
        agentId: triggerTable.agentId,
        workspaceId: triggerTable.workspaceId,
        organizationId: workspaceTable.organizationId,
      })
      .from(triggerTable)
      .innerJoin(
        workspaceTable,
        eq(workspaceTable.id, triggerTable.workspaceId),
      )
      .where(inArray(triggerTable.id, triggerIds));
    const byId = new Map(triggers.map((t) => [t.id, t]));

    for (const run of runs) {
      const trigger = byId.get(run.triggerId);
      if (!trigger) continue;
      const payload = terminalEvent(run, trigger);
      if (!payload) continue;
      dispatchWebhookEvent(
        trigger.organizationId,
        trigger.workspaceId,
        payload,
      );
      if (payload.event !== "trigger_run.failed") continue;
      try {
        await postFailedRunNotification(run, trigger);
      } catch (error) {
        logger.error(
          { runId: run.runId, error: errorMessage(error) },
          "Failed to post a Trigger run failure notification",
        );
      }
    }
  } catch (error) {
    logger.error(
      {
        runIds: runs.map((run) => run.runId),
        error: errorMessage(error),
      },
      "Failed to announce ended trigger runs",
    );
  }
};
