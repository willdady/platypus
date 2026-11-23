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

// why: read from the terminal write, not re-read, so a run pruned meanwhile is still announced
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
  stats?: TriggerRunStats | null;
};

type TriggerCoordinates = {
  name: string;
  type: TriggerType;
  agentId: string;
};

type AnnouncedTrigger = TriggerCoordinates & {
  id: string;
  workspaceId: string;
  organizationId: string;
};

const terminalEvent = (
  run: EndedTriggerRun,
  trigger: AnnouncedTrigger,
): TriggerRunWebhookEventPayload | null => {
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
