import { and, eq } from "drizzle-orm";
import { db } from "../index.ts";
import {
  webhook as webhookTable,
  trigger as triggerTable,
} from "../db/schema.ts";
import { deliverWebhook } from "./webhook-delivery.ts";
import { debounceTriggerExecution } from "./event-trigger-debounce.ts";
import { fireTrigger } from "./trigger-firing.ts";
import { narrowTriggerConfig } from "./trigger.ts";
import { logger } from "../logger.ts";
import {
  currentCausingAgents,
  currentOriginatingTrigger,
} from "../event-causation.ts";
import type {
  EventTriggerEventPayload,
  WebhookEventPayload,
} from "@platypus/schemas";
import { webhookEventEntity, webhookEventScope } from "@platypus/schemas";
import { errorMessage } from "../utils/error-message.ts";

const SHARED_BUCKET = "unknown";

const deliverToWebhooks = async (
  orgId: string,
  workspaceId: string,
  payload: WebhookEventPayload,
): Promise<void> => {
  const { event, data } = payload;
  const webhooks = await db
    .select()
    .from(webhookTable)
    .where(eq(webhookTable.workspaceId, workspaceId));
  if (webhooks.length === 0) return;

  const timestamp = new Date().toISOString();
  const body = JSON.stringify({ event, timestamp, orgId, workspaceId, data });

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
};

export function dispatchWebhookEvent(
  orgId: string,
  workspaceId: string,
  payload: WebhookEventPayload,
): void {
  void deliverToWebhooks(orgId, workspaceId, payload).catch(
    (error: unknown) => {
      logger.error(
        {
          workspaceId,
          event: payload.event,
          error: errorMessage(error),
        },
        "Webhook event dispatch failed unexpectedly",
      );
    },
  );
}

export function dispatchEvent(
  orgId: string,
  workspaceId: string,
  payload: EventTriggerEventPayload,
): void {
  const { event } = payload;
  const causingAgents = currentCausingAgents();
  const originatingTriggerId = currentOriginatingTrigger();

  const logDecision = (
    trigger: { id: string; agentId: string | null },
    decision: "fired" | "skipped_self_actor" | "debounced" | "suppressed",
  ): void => {
    logger.info(
      {
        event,
        workspaceId,
        triggerId: trigger.id,
        triggerAgentId: trigger.agentId,
        causingAgents,
        originatingTriggerId,
        decision,
      },
      "Event trigger dispatch decision",
    );
  };

  const entity = webhookEventEntity(payload);
  const scope = webhookEventScope(payload);
  const breakerEntityId = entity.kind === "entity" ? entity.id : undefined;

  void (async () => {
    try {
      await deliverToWebhooks(orgId, workspaceId, payload);

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
        let typed: ReturnType<typeof narrowTriggerConfig>;
        try {
          typed = narrowTriggerConfig(trigger);
        } catch (error) {
          logger.error(
            {
              triggerId: trigger.id,
              error: errorMessage(error),
            },
            "Skipped a malformed event trigger",
          );
          continue;
        }
        if (typed.type !== "event") continue;
        const triggerConfig = typed.config;
        if (!triggerConfig.events.includes(event)) continue;

        if (
          triggerConfig.filters?.boardId &&
          scope.boardId !== triggerConfig.filters.boardId
        ) {
          continue;
        }
        if (
          triggerConfig.filters?.columnId &&
          scope.columnId !== triggerConfig.filters.columnId
        ) {
          continue;
        }
        if (
          payload.event === "card.updated" &&
          triggerConfig.filters?.changedFields
        ) {
          const filterFields = triggerConfig.filters.changedFields;
          if (
            !payload.data.changedFields.some((field): boolean =>
              filterFields.includes(field),
            )
          ) {
            continue;
          }
        }

        if (trigger.agentId && causingAgents.includes(trigger.agentId)) {
          logDecision(trigger, "skipped_self_actor");
          continue;
        }

        const debounceKey = `${trigger.id}:${
          entity.kind === "entity" ? entity.id : SHARED_BUCKET
        }`;

        const coalesced = debounceTriggerExecution(
          debounceKey,
          trigger,
          { payload, entityId: breakerEntityId },
          async (t, ctx) => {
            const outcome = await fireTrigger(t, { kind: "event", ...ctx });
            if (outcome === "suppressed") logDecision(t, "suppressed");
          },
        );

        logDecision(trigger, coalesced ? "debounced" : "fired");
      }
    } catch (error) {
      logger.error(
        {
          workspaceId,
          event,
          error: errorMessage(error),
        },
        "Event dispatch failed unexpectedly",
      );
    }
  })();
}
