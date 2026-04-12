import crypto from "node:crypto";
import { logger } from "../logger.ts";

const MAX_RETRIES = 3;
const RETRY_DELAYS = [1000, 2000, 4000];
const TIMEOUT_MS = 10_000;

function computeSignature(payload: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

export async function deliverWebhook(
  url: string,
  payload: string,
  signingSecret: string,
  timestamp: string,
  customHeaders: Record<string, string> | null,
): Promise<void> {
  const signature = computeSignature(payload, signingSecret);

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
