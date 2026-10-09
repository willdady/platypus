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
import type {
  TriggerRunWebhookEventPayload,
  TriggerType,
} from "@platypus/schemas";

/**
 * The columns a terminal write returns so its run can be announced. Taken from
 * the write itself rather than re-read afterwards, so a run retention prunes in
 * the meantime is still announced.
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
};

type TriggerCoordinates = {
  name: string;
  type: TriggerType;
  agentId: string;
};

/** A run's terminal event, or `null` for a status that is not terminal. */
const terminalEvent = (
  run: EndedTriggerRun,
  trigger: TriggerCoordinates & { id: string },
): TriggerRunWebhookEventPayload | null => {
  // Every field is on the wire, an empty one as `null` rather than absent.
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
 * Announces Trigger runs that have just reached a terminal status, as
 * `trigger_run.*` Webhook events.
 *
 * Exactly one event per run rests on the caller: pass only the rows a terminal
 * write actually changed — a write conditional on the row still being
 * `pending`/`running`, or the insert of a `suppressed` row — so whichever
 * instance won the write is the only one that announces. Delivery is
 * in-process, never over the cross-instance channel.
 *
 * A run whose Trigger has since been deleted announces nothing. Never rejects:
 * a failed lookup is logged and the events are lost, as a Webhook delivery is
 * best-effort.
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
      const payload = terminalEvent(run, {
        ...trigger,
        type: trigger.type as TriggerType,
      });
      if (!payload) continue;
      dispatchWebhookEvent(
        trigger.organizationId,
        trigger.workspaceId,
        payload,
      );
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
