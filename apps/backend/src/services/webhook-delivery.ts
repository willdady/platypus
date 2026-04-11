import crypto from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "../index.ts";
import {
  webhook as webhookTable,
  trigger as triggerTable,
} from "../db/schema.ts";
import { executeTrigger } from "./trigger-execution.ts";
import { updateTriggerAfterRun } from "./trigger-execution.ts";
import { logger } from "../logger.ts";
import type { WebhookEvent, EventTriggerConfig } from "@platypus/schemas";

const MAX_RETRIES = 3;
const RETRY_DELAYS = [1000, 2000, 4000];
const TIMEOUT_MS = 10_000;

function computeSignature(payload: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

async function deliverWebhook(
  url: string,
  payload: string,
  signature: string,
  timestamp: string,
  customHeaders: Record<string, string> | null,
): Promise<void> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await new Promise((resolve) =>
        setTimeout(resolve, RETRY_DELAYS[attempt - 1]),
      );
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "X-Webhook-Signature": signature,
        "X-Webhook-Timestamp": timestamp,
        ...customHeaders,
      };

      const response = await fetch(url, {
        method: "POST",
        headers,
        body: payload,
        signal: controller.signal,
      });

      if (response.ok) {
        logger.info(
          { url, attempt: attempt + 1 },
          "Webhook delivered successfully",
        );
        return;
      }

      logger.warn(
        { url, status: response.status, attempt: attempt + 1 },
        "Webhook delivery failed with non-OK status",
      );
    } catch (error) {
      logger.warn(
        {
          url,
          attempt: attempt + 1,
          error: error instanceof Error ? error.message : String(error),
        },
        "Webhook delivery attempt failed",
      );
    } finally {
      clearTimeout(timeoutId);
    }
  }

  logger.error({ url }, "Webhook delivery exhausted all retries");
}

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

          const signature = computeSignature(body, webhook.signingSecret);

          // Fire each delivery independently so one failure doesn't block others
          void deliverWebhook(
            webhook.url,
            body,
            signature,
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
