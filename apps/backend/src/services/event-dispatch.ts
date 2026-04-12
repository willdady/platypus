import { and, eq } from "drizzle-orm";
import { db } from "../index.ts";
import {
  webhook as webhookTable,
  trigger as triggerTable,
} from "../db/schema.ts";
import { deliverWebhook } from "./webhook-delivery.ts";
import { executeTrigger } from "./trigger-execution.ts";
import { updateTriggerAfterRun } from "./trigger-execution.ts";
import { logger } from "../logger.ts";
import type { WebhookEvent, EventTriggerConfig } from "@platypus/schemas";

export function dispatchEvent(
  workspaceId: string,
  event: WebhookEvent,
  data: unknown,
): void {
  // Fire-and-forget — never awaited by the caller
  void (async () => {
    try {
      // 1. Deliver to webhooks
      const webhooks = await db
        .select()
        .from(webhookTable)
        .where(eq(webhookTable.workspaceId, workspaceId));

      if (webhooks.length > 0) {
        const timestamp = new Date().toISOString();
        const body = JSON.stringify({ event, timestamp, workspaceId, data });

        for (const webhook of webhooks) {
          if (!webhook.enabled) continue;
          if (!webhook.events.includes(event)) continue;

          void deliverWebhook(
            webhook.url,
            body,
            webhook.signingSecret,
            timestamp,
            webhook.headers,
          );
        }
      }

      // 2. Dispatch to event triggers
      const eventTriggers = await db
        .select()
        .from(triggerTable)
        .where(
          and(
            eq(triggerTable.workspaceId, workspaceId),
            eq(triggerTable.type, "event"),
            eq(triggerTable.enabled, true),
          ),
        );

      for (const trigger of eventTriggers) {
        const triggerConfig = trigger.config as EventTriggerConfig;
        if (!triggerConfig.events.includes(event)) continue;

        // Apply event filters
        if (triggerConfig.filters?.boardId) {
          const eventData = data as Record<string, unknown>;
          if (eventData.boardId !== triggerConfig.filters.boardId) continue;
        }
        if (triggerConfig.filters?.columnId) {
          const eventData = data as Record<string, unknown>;
          if (eventData.columnId !== triggerConfig.filters.columnId) continue;
        }

        // Fire-and-forget for each matching event trigger
        void (async () => {
          try {
            await executeTrigger(trigger, {
              eventType: event,
              eventData: data,
            });
            await updateTriggerAfterRun(trigger.id, trigger);
          } catch (error) {
            logger.error(
              {
                triggerId: trigger.id,
                event,
                error: error instanceof Error ? error.message : String(error),
              },
              "Event trigger execution failed",
            );
          }
        })();
      }
    } catch (error) {
      logger.error(
        {
          workspaceId,
          event,
          error: error instanceof Error ? error.message : String(error),
        },
        "Event dispatch failed unexpectedly",
      );
    }
  })();
}
