import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../index.ts";
import { webhook as webhookTable } from "../db/schema.ts";
import { logger } from "../logger.ts";
import type { WebhookEvent } from "@platypus/schemas";

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

export function dispatchWebhook(
  workspaceId: string,
  event: WebhookEvent,
  data: unknown,
): void {
  // Fire-and-forget — never awaited by the caller
  void (async () => {
    try {
      const webhooks = await db
        .select()
        .from(webhookTable)
        .where(eq(webhookTable.workspaceId, workspaceId))
        .limit(1);

      if (webhooks.length === 0) return;

      const webhook = webhooks[0];
      if (!webhook.enabled) return;
      if (!webhook.events.includes(event)) return;

      const timestamp = new Date().toISOString();
      const body = JSON.stringify({ event, timestamp, workspaceId, data });
      const signature = computeSignature(body, webhook.signingSecret);

      await deliverWebhook(
        webhook.url,
        body,
        signature,
        timestamp,
        webhook.headers,
      );
    } catch (error) {
      logger.error(
        {
          workspaceId,
          event,
          error: error instanceof Error ? error.message : String(error),
        },
        "Webhook dispatch failed unexpectedly",
      );
    }
  })();
}
