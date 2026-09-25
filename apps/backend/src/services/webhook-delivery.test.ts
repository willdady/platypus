import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import crypto from "node:crypto";

/** Typed shape of the fetch options captured by mockFetch spy calls. */
interface WebhookFetchOptions {
  method: string;
  redirect: string;
  headers: Record<string, string>;
  body: string;
}

/** Pull typed call args from mockFetch.mock.calls[n]. */
const getFetchCall = (
  calls: Parameters<typeof fetch>[],
  index: number,
): [string, WebhookFetchOptions] => {
  const [url, opts] = calls[index];
  return [url as string, opts as WebhookFetchOptions];
};

// Mock the db and logger before importing the module
const mockWebhookSelect = vi.fn();

vi.mock("../index.ts", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: mockWebhookSelect,
      })),
    })),
  },
}));

const mockCheckEgress = vi.hoisted(() => vi.fn());
vi.mock("../utils/egress-guard.ts", () => ({ checkEgress: mockCheckEgress }));

vi.mock("./trigger-firing.ts", () => ({
  fireTrigger: vi.fn(),
}));

vi.mock("./event-trigger-debounce.ts", () => ({
  debounceTriggerExecution: vi.fn(),
}));

import { eq } from "drizzle-orm";
import { webhook as webhookTable } from "../db/schema.ts";
import { dispatchEvent } from "./event-dispatch.ts";
import { notificationEvent } from "../test-utils.ts";
import { logger } from "../logger.ts";

describe("Webhook Delivery Service", () => {
  const mockFetch = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    global.fetch = mockFetch;
    mockCheckEgress.mockResolvedValue({ allowed: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const allEvents = [
    "notification.created",
    "notification.updated",
    "notification.read",
    "notification.dismissed",
    "card.created",
    "card.updated",
    "card.deleted",
  ];

  const sampleWebhook = {
    id: "wh-1",
    workspaceId: "ws-1",
    name: "Test Webhook",
    url: "https://example.com/webhook",
    signingSecret: "test-secret-key",
    headers: null,
    enabled: true,
    events: allEvents,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  it("should deliver webhook with correct headers and body", async () => {
    mockWebhookSelect.mockResolvedValueOnce([sampleWebhook]);
    mockFetch.mockResolvedValueOnce({ ok: true } as Response);

    const created = notificationEvent("notification.created");
    dispatchEvent("org-1", "ws-1", created);

    // Allow the async fire-and-forget to complete
    await vi.advanceTimersByTimeAsync(100);

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, options] = getFetchCall(mockFetch.mock.calls, 0);
    expect(url).toBe("https://example.com/webhook");
    expect(options.method).toBe("POST");
    expect(options.redirect).toBe("manual");
    expect(options.headers["Content-Type"]).toBe("application/json");
    // Only the dispatching Workspace's webhooks are read.
    expect(mockWebhookSelect).toHaveBeenCalledWith(
      eq(webhookTable.workspaceId, "ws-1"),
    );

    const body = JSON.parse(options.body) as {
      event: string;
      timestamp: string;
      orgId: string;
      workspaceId: string;
      data: unknown;
    };
    // The signed timestamp header is the one carried in the signed body.
    expect(options.headers["X-Webhook-Timestamp"]).toBe(body.timestamp);
    expect(new Date(body.timestamp).toISOString()).toBe(body.timestamp);
    expect(body.event).toBe("notification.created");
    expect(body.orgId).toBe("org-1");
    expect(body.workspaceId).toBe("ws-1");
    expect(body.data).toEqual(
      JSON.parse(JSON.stringify(created.data)) as unknown,
    );
  });

  it("should compute correct HMAC-SHA256 signature", async () => {
    mockWebhookSelect.mockResolvedValueOnce([sampleWebhook]);
    mockFetch.mockResolvedValueOnce({ ok: true } as Response);

    dispatchEvent("org-1", "ws-1", notificationEvent("notification.created"));

    await vi.advanceTimersByTimeAsync(100);

    const [, options] = getFetchCall(mockFetch.mock.calls, 0);
    const signature = options.headers["X-Webhook-Signature"];
    const expectedSignature = crypto
      .createHmac("sha256", sampleWebhook.signingSecret)
      .update(options.body)
      .digest("hex");

    expect(signature).toBe(expectedSignature);
  });

  it("should include custom headers in request", async () => {
    const webhookWithHeaders = {
      ...sampleWebhook,
      headers: { Authorization: "Bearer token123", "X-Custom": "value" },
    };
    mockWebhookSelect.mockResolvedValueOnce([webhookWithHeaders]);
    mockFetch.mockResolvedValueOnce({ ok: true } as Response);

    dispatchEvent("org-1", "ws-1", notificationEvent("notification.created"));

    await vi.advanceTimersByTimeAsync(100);

    const [, options] = getFetchCall(mockFetch.mock.calls, 0);
    expect(options.headers["Authorization"]).toBe("Bearer token123");
    expect(options.headers["X-Custom"]).toBe("value");
  });

  it("should retry on failure and succeed", async () => {
    mockWebhookSelect.mockResolvedValueOnce([sampleWebhook]);
    mockFetch
      .mockRejectedValueOnce(new Error("Network error"))
      .mockResolvedValueOnce({ ok: true } as Response);

    dispatchEvent("org-1", "ws-1", notificationEvent("notification.created"));

    // First attempt fails immediately
    await vi.advanceTimersByTimeAsync(100);
    // Wait for retry delay (1s)
    await vi.advanceTimersByTimeAsync(1100);

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ attempt: 2 }),
      "Webhook delivered successfully",
    );
  });

  it("retries a non-OK response", async () => {
    mockWebhookSelect.mockResolvedValueOnce([sampleWebhook]);
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 503 } as Response)
      .mockResolvedValueOnce({ ok: true } as Response);

    dispatchEvent("org-1", "ws-1", notificationEvent("notification.created"));

    await vi.advanceTimersByTimeAsync(100);
    expect(logger.warn).toHaveBeenCalledWith(
      { url: sampleWebhook.url, status: 503, attempt: 1 },
      "Webhook delivery failed with non-OK status",
    );
    await vi.advanceTimersByTimeAsync(1100);

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("aborts an attempt that outlives the 10s timeout, then retries", async () => {
    mockWebhookSelect.mockResolvedValueOnce([sampleWebhook]);
    mockFetch
      .mockImplementationOnce(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new Error("aborted")),
            );
          }),
      )
      .mockResolvedValueOnce({ ok: true } as Response);

    dispatchEvent("org-1", "ws-1", notificationEvent("notification.created"));

    await vi.advanceTimersByTimeAsync(9_000);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ attempt: 1, error: "aborted" }),
      "Webhook delivery attempt failed",
    );
    await vi.advanceTimersByTimeAsync(1_100);

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("should log error when all retries exhausted", async () => {
    mockWebhookSelect.mockResolvedValueOnce([sampleWebhook]);
    mockFetch.mockRejectedValue(new Error("Network error"));

    dispatchEvent("org-1", "ws-1", notificationEvent("notification.created"));

    // Advance through all retries: initial + 1s + 2s + 4s
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(1100);
    await vi.advanceTimersByTimeAsync(2100);
    await vi.advanceTimersByTimeAsync(4100);

    expect(mockFetch).toHaveBeenCalledTimes(4); // initial + 3 retries
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://example.com/webhook" }),
      "Webhook delivery exhausted all retries",
    );
  });

  it("should deliver to multiple webhooks", async () => {
    const webhook2 = {
      ...sampleWebhook,
      id: "wh-2",
      name: "Second Webhook",
      url: "https://other.com/webhook",
      signingSecret: "other-secret",
    };
    mockWebhookSelect.mockResolvedValueOnce([sampleWebhook, webhook2]);
    mockFetch.mockResolvedValue({ ok: true } as Response);

    dispatchEvent("org-1", "ws-1", notificationEvent("notification.created"));

    await vi.advanceTimersByTimeAsync(100);

    expect(mockFetch).toHaveBeenCalledTimes(2);

    const [url1, opts1] = getFetchCall(mockFetch.mock.calls, 0);
    const [url2, opts2] = getFetchCall(mockFetch.mock.calls, 1);
    expect(url1).toBe("https://example.com/webhook");
    expect(url2).toBe("https://other.com/webhook");

    // Each webhook should have a different signature (different signing secrets)
    expect(opts1.headers["X-Webhook-Signature"]).not.toBe(
      opts2.headers["X-Webhook-Signature"],
    );
  });

  it("should continue delivery when one webhook fails", async () => {
    const webhook2 = {
      ...sampleWebhook,
      id: "wh-2",
      name: "Second Webhook",
      url: "https://other.com/webhook",
      signingSecret: "other-secret",
    };
    mockWebhookSelect.mockResolvedValueOnce([sampleWebhook, webhook2]);
    // First webhook fails, second succeeds
    mockFetch
      .mockRejectedValueOnce(new Error("Network error"))
      .mockResolvedValueOnce({ ok: true } as Response);

    dispatchEvent("org-1", "ws-1", notificationEvent("notification.created"));

    await vi.advanceTimersByTimeAsync(100);

    // Both webhooks should have been attempted
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const [url2] = getFetchCall(mockFetch.mock.calls, 1);
    expect(url2).toBe("https://other.com/webhook");
  });

  it("should not deliver to a URL the network policy blocks", async () => {
    mockWebhookSelect.mockResolvedValueOnce([sampleWebhook]);
    mockCheckEgress.mockResolvedValue({
      allowed: false,
      reason: "'example.com' resolves to 127.0.0.1 (loopback)",
    });

    dispatchEvent("org-1", "ws-1", notificationEvent("notification.created"));

    await vi.advanceTimersByTimeAsync(8000);

    expect(mockCheckEgress).toHaveBeenCalledWith("https://example.com/webhook");
    expect(mockFetch).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://example.com/webhook" }),
      "Webhook delivery blocked by network policy",
    );
  });
});
