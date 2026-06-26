import { and, eq } from "drizzle-orm";
import { db } from "../index.ts";
import {
  webhook as webhookTable,
  trigger as triggerTable,
} from "../db/schema.ts";
import { deliverWebhook } from "./webhook-delivery.ts";
import { executeTrigger } from "./trigger-execution.ts";
import { updateTriggerAfterRun } from "./trigger-execution.ts";
import { debounceTriggerExecution } from "./event-trigger-debounce.ts";
import { logger } from "../logger.ts";
import type { WebhookEvent, EventTriggerConfig } from "@platypus/schemas";

/**
 * Optional context about who caused the event being dispatched.
 *
 * `actorAgentId` is the agent that performed the write. It is supplied by
 * agent-facing tool write paths and is absent for human-originated (HTTP
 * route) writes. The dispatcher uses it to skip an event trigger when the
 * trigger's own agent caused the event — preventing an agent's writes from
 * re-firing the very trigger that started it (see #267).
 *
 * This is keyed off the actor of *this specific event*, not a persisted
 * attribution column (e.g. `lastEditedByAgentId`), which is sticky and would
 * cause false-negatives on later human edits.
 */
export interface DispatchEventOptions {
  actorAgentId?: string;
}

export function dispatchEvent(
  orgId: string,
  workspaceId: string,
  event: WebhookEvent,
  data: unknown,
  options?: DispatchEventOptions,
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
        const body = JSON.stringify({
          event,
          timestamp,
          orgId,
          workspaceId,
          data,
        });

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

        // Self-actor guard: skip when the agent that caused this event is the
        // very same agent this trigger would run. This stops an agent's own
        // card writes from re-firing the trigger that started it (#267).
        // Human-originated events carry no actor, so they always pass.
        if (
          options?.actorAgentId &&
          trigger.agentId &&
          trigger.agentId === options.actorAgentId
        ) {
          continue;
        }

        // Apply event filters
        if (triggerConfig.filters?.boardId) {
          const eventData = data as Record<string, unknown>;
          if (eventData.boardId !== triggerConfig.filters.boardId) continue;
        }
        if (triggerConfig.filters?.columnId) {
          const eventData = data as Record<string, unknown>;
          if (eventData.columnId !== triggerConfig.filters.columnId) continue;
        }

        // Debounce per trigger+entity to coalesce rapid events
        const entityId = (data as { id?: string | number })?.id ?? "unknown";
        const debounceKey = `${trigger.id}:${entityId}`;

        debounceTriggerExecution(
          debounceKey,
          trigger,
          { eventType: event, eventData: data },
          async (t, ctx) => {
            try {
              await executeTrigger(t, ctx);
              await updateTriggerAfterRun(t.id, t);
            } catch (error) {
              logger.error(
                {
                  triggerId: t.id,
                  event,
                  error: error instanceof Error ? error.message : String(error),
                },
                "Event trigger execution failed",
              );
            }
          },
        );
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
