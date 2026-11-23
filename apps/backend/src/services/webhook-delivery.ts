import crypto from "node:crypto";
import { logger } from "../logger.ts";
import { checkEgress } from "../utils/egress-guard.ts";
import { errorMessage } from "../utils/error-message.ts";

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
  await postWithRetries({
    url,
    body: payload,
    headers: {
      "Content-Type": "application/json",
      "X-Webhook-Signature": computeSignature(payload, signingSecret),
      "X-Webhook-Timestamp": timestamp,
      ...customHeaders,
    },
    label: "Webhook",
  });
}

export async function postWithRetries(params: {
  url: string;
  body: string;
  headers: Record<string, string>;
  label: string;
  allowPrivateNetworks?: boolean;
}): Promise<void> {
  const { url, body, headers, label, allowPrivateNetworks } = params;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await new Promise((resolve) =>
        setTimeout(resolve, RETRY_DELAYS[attempt - 1]),
      );
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      // why: every attempt, since a user-supplied URL's DNS can change between retries
      const egress = await checkEgress(url, { allowPrivateNetworks });
      if (!egress.allowed) {
        logger.warn(
          { url, reason: egress.reason },
          `${label} delivery blocked by network policy`,
        );
        return;
      }

      const response = await fetch(url, {
        method: "POST",
        headers,
        body,
        redirect: "manual",
        signal: controller.signal,
      });

      if (response.ok) {
        logger.info(
          { url, attempt: attempt + 1 },
          `${label} delivered successfully`,
        );
        return;
      }

      logger.warn(
        { url, status: response.status, attempt: attempt + 1 },
        `${label} delivery failed with non-OK status`,
      );
    } catch (error) {
      logger.warn(
        {
          url,
          attempt: attempt + 1,
          error: errorMessage(error),
        },
        `${label} delivery attempt failed`,
      );
    } finally {
      clearTimeout(timeoutId);
    }
  }

  logger.error({ url }, `${label} delivery exhausted all retries`);
}
