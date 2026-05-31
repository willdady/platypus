import { nanoid } from "nanoid";
import { and, desc, eq, notInArray, type Column } from "drizzle-orm";
import type { PgTable, PgColumn } from "drizzle-orm/pg-core";
import { db } from "../index.ts";
import {
  trigger as triggerTable,
  triggerRun as triggerRunTable,
  workspace as workspaceTable,
} from "../db/schema.ts";
import { logger } from "../logger.ts";
import { validateCronExpression } from "../utils/cron.ts";
import { agentRunner } from "../runs/agent-runner.ts";
import { TriggerSink } from "../runs/sinks/trigger-sink.ts";
import { workspaceScopeForTrigger } from "../scope.ts";
import { resolveRunTimeouts } from "./agent-run-settings.ts";
import type { RunInput } from "../runs/types.ts";
import type { PlatypusUIMessage } from "../types.ts";
import type { CronTriggerConfig, WebhookEvent } from "@platypus/schemas";

/**
 * Retains the newest N rows for a given foreign key and deletes the rest.
 */
async function retainNewest(
  table: PgTable,
  fkColumn: PgColumn,
  idColumn: PgColumn,
  orderColumn: Column,
  fkValue: string,
  limit: number,
  label: string,
): Promise<void> {
  const toKeep = await db
    .select({ id: idColumn })
    .from(table)
    .where(eq(fkColumn, fkValue))
    .orderBy(desc(orderColumn))
    .limit(limit);

  if (toKeep.length < limit) return;

  const idsToKeep = toKeep.map((r) => r.id as string);
  const deleted = await db
    .delete(table)
    .where(and(eq(fkColumn, fkValue), notInArray(idColumn, idsToKeep)))
    .returning({ id: idColumn });

  if (deleted.length > 0) {
    logger.info(
      {
        triggerId: fkValue,
        deletedCount: deleted.length,
        maxRunsToKeep: limit,
      },
      `Cleaned up old ${label}`,
    );
  }
}

export type EventContext = {
  eventType: WebhookEvent;
  eventData: unknown;
};

/**
 * Executes a trigger by running the agent with the configured instruction.
 * For event triggers, event context is prepended to the instruction.
 * Returns the trigger run ID.
 */
export const executeTrigger = async (
  trigger: typeof triggerTable.$inferSelect,
  eventContext?: EventContext,
): Promise<string> => {
  const { id, workspaceId, agentId, instruction } = trigger;
  const runId = nanoid();

  // Workspace is fetched up-front to derive the run scope. The runner
  // re-reads it for system-prompt context — at trigger volumes the extra
  // round-trip is acceptable.
  const [workspace] = await db
    .select()
    .from(workspaceTable)
    .where(eq(workspaceTable.id, workspaceId))
    .limit(1);

  if (!workspace) {
    // No row inserted yet — surface as a thrown error to match scheduler /
    // event-dispatch error handling.
    throw new Error(`Workspace '${workspaceId}' not found for trigger '${id}'`);
  }

  const scope = workspaceScopeForTrigger({
    triggerId: id,
    workspaceId,
    organizationId: workspace.organizationId,
    ownerUserId: workspace.ownerId,
    ownerName: "Trigger User",
  });

  const effectiveInstruction = eventContext
    ? `Event: ${eventContext.eventType}\nEvent Data:\n${JSON.stringify(eventContext.eventData, null, 2)}\n---\n${instruction}`
    : instruction;

  const messages: PlatypusUIMessage[] = [
    {
      id: nanoid(),
      role: "user",
      parts: [{ type: "text", text: effectiveInstruction }],
    } as PlatypusUIMessage,
  ];

  const input: RunInput = {
    runId,
    request: { agentId, search: trigger.search ?? undefined },
    messages,
  };

  const sink = new TriggerSink({
    triggerId: id,
    eventType: eventContext?.eventType,
    eventData: eventContext?.eventData,
  });

  logger.info(
    {
      triggerId: id,
      runId,
      agentId,
      type: trigger.type,
      instruction: effectiveInstruction.substring(0, 100) + "...",
    },
    "Starting trigger execution",
  );

  const timeouts = await resolveRunTimeouts(
    workspace.organizationId,
    "trigger",
  );

  await agentRunner.generate({
    scope,
    input,
    sink,
    options: {
      frontendUrl: process.env.FRONTEND_URL,
      timeouts,
    },
  });

  return runId;
};

/**
 * Updates the trigger after execution:
 * - Sets lastRunAt
 * - For cron: computes nextRunAt, handles one-off disable
 * - For event: just updates lastRunAt
 * - Performs retention cleanup
 */
export const updateTriggerAfterRun = async (
  triggerId: string,
  trigger: typeof triggerTable.$inferSelect,
): Promise<void> => {
  const now = new Date();
  const { maxRunsToKeep, type, config } = trigger;

  let nextRunAt: Date | null = null;
  let enabled = true;

  if (type === "cron") {
    const cronConfig = config as CronTriggerConfig;
    if (cronConfig.isOneOff) {
      // One-off triggers are disabled after first run
      enabled = false;
    } else {
      nextRunAt = validateCronExpression(
        cronConfig.cronExpression,
        cronConfig.timezone,
      );
      if (!nextRunAt) {
        logger.error(
          { triggerId, cronExpression: cronConfig.cronExpression },
          "Failed to compute next run for trigger",
        );
      }
    }
  }
  // For event triggers, nextRunAt stays null and enabled stays true

  // Update the trigger
  await db
    .update(triggerTable)
    .set({
      lastRunAt: now,
      nextRunAt,
      enabled,
      updatedAt: now,
    })
    .where(eq(triggerTable.id, triggerId));

  // Retention cleanup: delete old runs beyond maxRunsToKeep
  if (maxRunsToKeep > 0) {
    await retainNewest(
      triggerRunTable,
      triggerRunTable.triggerId,
      triggerRunTable.id,
      triggerRunTable.startedAt,
      triggerId,
      maxRunsToKeep,
      "trigger runs",
    );
  }

  logger.info(
    {
      triggerId,
      type,
      enabled,
      nextRunAt: nextRunAt?.toISOString(),
    },
    "Updated trigger after run",
  );
};
