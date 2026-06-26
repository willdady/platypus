import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import crypto from "node:crypto";

/** Typed shape of the fetch options captured by mockFetch spy calls. */
interface WebhookFetchOptions {
  method: string;
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

vi.mock("../logger.ts", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("./trigger-execution.ts", () => ({
  executeTrigger: vi.fn(),
  updateTriggerAfterRun: vi.fn(),
}));

vi.mock("./event-trigger-debounce.ts", () => ({
  debounceTriggerExecution: vi.fn(),
}));

import { dispatchEvent } from "./event-dispatch.ts";
import { logger } from "../logger.ts";

describe("Webhook Delivery Service", () => {
  const mockFetch = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    global.fetch = mockFetch;
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

    dispatchEvent("org-1", "ws-1", "notification.created", { id: "n-1" });

    // Allow the async fire-and-forget to complete
    await vi.advanceTimersByTimeAsync(100);

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, options] = getFetchCall(mockFetch.mock.calls, 0);
    expect(url).toBe("https://example.com/webhook");
    expect(options.method).toBe("POST");
    expect(options.headers["Content-Type"]).toBe("application/json");
    expect(options.headers["X-Webhook-Signature"]).toBeDefined();
    expect(options.headers["X-Webhook-Timestamp"]).toBeDefined();

    const body = JSON.parse(options.body) as {
      event: string;
      orgId: string;
      workspaceId: string;
      data: unknown;
    };
    expect(body.event).toBe("notification.created");
    expect(body.orgId).toBe("org-1");
    expect(body.workspaceId).toBe("ws-1");
    expect(body.data).toEqual({ id: "n-1" });
  });

  it("should compute correct HMAC-SHA256 signature", async () => {
    mockWebhookSelect.mockResolvedValueOnce([sampleWebhook]);
    mockFetch.mockResolvedValueOnce({ ok: true } as Response);

    dispatchEvent("org-1", "ws-1", "notification.created", { id: "n-1" });

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

    dispatchEvent("org-1", "ws-1", "notification.created", {});

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

    dispatchEvent("org-1", "ws-1", "notification.created", {});

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

  it("should log error when all retries exhausted", async () => {
    mockWebhookSelect.mockResolvedValueOnce([sampleWebhook]);
    mockFetch.mockRejectedValue(new Error("Network error"));

    dispatchEvent("org-1", "ws-1", "notification.created", {});

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

  it("should skip when webhook is disabled", async () => {
    mockWebhookSelect.mockResolvedValueOnce([
      { ...sampleWebhook, enabled: false },
    ]);

    dispatchEvent("org-1", "ws-1", "notification.created", {});

    await vi.advanceTimersByTimeAsync(100);

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("should skip when no webhook configured", async () => {
    mockWebhookSelect.mockResolvedValueOnce([]);

    dispatchEvent("org-1", "ws-1", "notification.created", {});

    await vi.advanceTimersByTimeAsync(100);

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("should skip when event is not in webhook's events list", async () => {
    mockWebhookSelect.mockResolvedValueOnce([
      { ...sampleWebhook, events: ["notification.created"] },
    ]);

    dispatchEvent("org-1", "ws-1", "notification.dismissed", { id: "n-1" });

    await vi.advanceTimersByTimeAsync(100);

    expect(mockFetch).not.toHaveBeenCalled();
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

    dispatchEvent("org-1", "ws-1", "notification.created", { id: "n-1" });

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

  it("should skip webhooks not subscribed to the event", async () => {
    const webhook2 = {
      ...sampleWebhook,
      id: "wh-2",
      name: "Limited Webhook",
      url: "https://other.com/webhook",
      events: ["notification.created"],
    };
    mockWebhookSelect.mockResolvedValueOnce([sampleWebhook, webhook2]);
    mockFetch.mockResolvedValue({ ok: true } as Response);

    dispatchEvent("org-1", "ws-1", "notification.dismissed", { id: "n-1" });

    await vi.advanceTimersByTimeAsync(100);

    // Only the first webhook subscribes to notification.dismissed
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url] = getFetchCall(mockFetch.mock.calls, 0);
    expect(url).toBe("https://example.com/webhook");
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

    dispatchEvent("org-1", "ws-1", "notification.created", { id: "n-1" });

    await vi.advanceTimersByTimeAsync(100);

    // Both webhooks should have been attempted
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const [url2] = getFetchCall(mockFetch.mock.calls, 1);
    expect(url2).toBe("https://other.com/webhook");
  });
});
