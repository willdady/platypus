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
import { currentCausingAgents } from "../event-causation.ts";
import type { WebhookEvent, EventTriggerConfig } from "@platypus/schemas";

/**
 * The debounce bucket an event with no single entity falls back to. Bulk
 * `notification.read` lands here by design — it names a set of notifications,
 * so coalescing two of them into one run is correct.
 */
const SHARED_BUCKET = "unknown";

/** The entity id an event's data carries under `key`, or `undefined`. */
const entityIdOf = (
  eventData: unknown,
  key: "id" | "cardId" | "notificationId",
): string | number | undefined => {
  const value = (eventData as Record<string, unknown> | null | undefined)?.[
    key
  ];
  return typeof value === "string" || typeof value === "number"
    ? value
    : undefined;
};

export function dispatchEvent(
  orgId: string,
  workspaceId: string,
  event: WebhookEvent,
  data: unknown,
): void {
  // Causation is ambient run context (ADR-0022): the chain of Agents acting
  // when the write happened, read once here so the fire-and-forget body below
  // keeps a stable view of it. A human write establishes no chain, so it reads
  // empty and no guard engages. Keyed off the ambient actor rather than a
  // persisted attribution column (e.g. `lastEditedByAgentId`), which is sticky
  // and would cause false-negatives on later human edits.
  const causingAgents = currentCausingAgents();

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
        // very same agent this trigger would run — or a delegate beneath it, at
        // any depth. This stops an agent's own card writes (through any of its
        // Sub-Agents) from re-firing the trigger that started it (#267, #668).
        // Human-originated events carry an empty chain, so they always pass.
        if (trigger.agentId && causingAgents.includes(trigger.agentId)) {
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
        // Only `card.updated` reports a changed-fields diff, so the filter is
        // scoped to it: a `card.moved`/`card.created`/`card.deleted` selected
        // alongside it keeps firing rather than being silently suppressed.
        if (event === "card.updated" && triggerConfig.filters?.changedFields) {
          const eventData = data as Record<string, unknown>;
          const changedFields = eventData.changedFields;
          const filterFields = triggerConfig.filters.changedFields;
          if (
            !Array.isArray(changedFields) ||
            !changedFields.some(
              (field): boolean =>
                typeof field === "string" && filterFields.includes(field),
            )
          ) {
            continue;
          }
        }

        // Debounce per trigger+entity to coalesce rapid events. Only the
        // row-spreading events (`card.created`/`updated`/`moved`,
        // `notification.created`/`updated`) carry a top-level `id`; the rest
        // name their entity under an event-specific key, and reading `id`
        // alone dropped all of them into SHARED_BUCKET per trigger, so two
        // unrelated entities coalesced into a single run (#811). A new event
        // naming its id under some further key would regress the same way —
        // the chain below is structural, not enforced per event.
        const entityId =
          entityIdOf(data, "id") ??
          entityIdOf(data, "cardId") ??
          entityIdOf(data, "notificationId") ??
          SHARED_BUCKET;
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
