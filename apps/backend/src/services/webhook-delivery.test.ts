import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import crypto from "node:crypto";

// Mock the db and logger before importing the module
const mockWebhookSelect = vi.fn();

vi.mock("../index.ts", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: mockWebhookSelect,
        })),
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

import { dispatchWebhook } from "./webhook-delivery.ts";
import { logger } from "../logger.ts";

describe("Webhook Delivery Service", () => {
  const mockFetch = vi.fn();

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
  ];

  const sampleWebhook = {
    id: "wh-1",
    workspaceId: "ws-1",
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
    mockFetch.mockResolvedValueOnce({ ok: true });

    dispatchWebhook("ws-1", "notification.created", { id: "n-1" });

    // Allow the async fire-and-forget to complete
    await vi.advanceTimersByTimeAsync(100);

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe("https://example.com/webhook");
    expect(options.method).toBe("POST");
    expect(options.headers["Content-Type"]).toBe("application/json");
    expect(options.headers["X-Webhook-Signature"]).toBeDefined();
    expect(options.headers["X-Webhook-Timestamp"]).toBeDefined();

    const body = JSON.parse(options.body);
    expect(body.event).toBe("notification.created");
    expect(body.workspaceId).toBe("ws-1");
    expect(body.data).toEqual({ id: "n-1" });
  });

  it("should compute correct HMAC-SHA256 signature", async () => {
    mockWebhookSelect.mockResolvedValueOnce([sampleWebhook]);
    mockFetch.mockResolvedValueOnce({ ok: true });

    dispatchWebhook("ws-1", "notification.created", { id: "n-1" });

    await vi.advanceTimersByTimeAsync(100);

    const [, options] = mockFetch.mock.calls[0];
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
    mockFetch.mockResolvedValueOnce({ ok: true });

    dispatchWebhook("ws-1", "notification.created", {});

    await vi.advanceTimersByTimeAsync(100);

    const [, options] = mockFetch.mock.calls[0];
    expect(options.headers["Authorization"]).toBe("Bearer token123");
    expect(options.headers["X-Custom"]).toBe("value");
  });

  it("should retry on failure and succeed", async () => {
    mockWebhookSelect.mockResolvedValueOnce([sampleWebhook]);
    mockFetch
      .mockRejectedValueOnce(new Error("Network error"))
      .mockResolvedValueOnce({ ok: true });

    dispatchWebhook("ws-1", "notification.created", {});

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

    dispatchWebhook("ws-1", "notification.created", {});

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

    dispatchWebhook("ws-1", "notification.created", {});

    await vi.advanceTimersByTimeAsync(100);

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("should skip when no webhook configured", async () => {
    mockWebhookSelect.mockResolvedValueOnce([]);

    dispatchWebhook("ws-1", "notification.created", {});

    await vi.advanceTimersByTimeAsync(100);

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("should skip when event is not in webhook's events list", async () => {
    mockWebhookSelect.mockResolvedValueOnce([
      { ...sampleWebhook, events: ["notification.created"] },
    ]);

    dispatchWebhook("ws-1", "notification.dismissed", { id: "n-1" });

    await vi.advanceTimersByTimeAsync(100);

    expect(mockFetch).not.toHaveBeenCalled();
  });
});
