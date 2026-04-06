import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockDb, mockSession, resetMockDb } from "../test-utils.ts";
import app from "../server.ts";

// Mock crypto.randomBytes for predictable signing secrets
vi.mock("node:crypto", async () => {
  const actual = await vi.importActual("node:crypto");
  return {
    ...actual,
    default: {
      ...(actual as any).default,
      randomBytes: vi
        .fn()
        .mockReturnValue(
          Buffer.from("a".repeat(32)),
        ),
    },
  };
});

describe("Webhook Routes", () => {
  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
    mockDb.where.mockReturnValue(mockDb);
  });

  const orgId = "org-1";
  const workspaceId = "ws-1";
  const baseUrl = `/organizations/${orgId}/workspaces/${workspaceId}/webhook`;

  describe("POST /", () => {
    it("should create webhook and return 201", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]); // requireWorkspaceAccess

      const mockWebhook = {
        id: "wh-1",
        workspaceId,
        url: "https://example.com/webhook",
        signingSecret: "secret",
        headers: null,
        enabled: true,
        events: [
          "notification.created",
          "notification.updated",
          "notification.read",
          "notification.dismissed",
        ],
      };
      mockDb.returning.mockResolvedValueOnce([mockWebhook]);

      const res = await app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify({
          url: "https://example.com/webhook",
        }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.url).toBe("https://example.com/webhook");
    });

    it("should return 409 if webhook already exists", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]); // requireWorkspaceAccess

      const drizzleError = new Error("DrizzleQueryError: Failed query");
      (drizzleError as any).cause = {
        code: "23505",
        message: "duplicate key value violates unique constraint",
      };
      mockDb.returning.mockRejectedValueOnce(drizzleError);

      const res = await app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify({
          url: "https://example.com/webhook",
        }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        message: "A webhook already exists for this workspace",
      });
    });
  });

  describe("GET /", () => {
    it("should return webhook with headers", async () => {
      mockSession();
      mockDb.limit
        .mockResolvedValueOnce([{ role: "member" }]) // requireOrgAccess
        .mockResolvedValueOnce([{ ownerId: "user-1" }]) // requireWorkspaceAccess
        .mockResolvedValueOnce([
          {
            id: "wh-1",
            workspaceId,
            url: "https://example.com/webhook",
            signingSecret: "secret",
            headers: { Authorization: "Bearer real-token" },
            enabled: true,
            events: [
              "notification.created",
              "notification.updated",
              "notification.read",
              "notification.dismissed",
            ],
          },
        ]);

      const res = await app.request(baseUrl);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.headers).toEqual({ Authorization: "Bearer real-token" });
    });

    it("should return 404 if no webhook configured", async () => {
      mockSession();
      mockDb.limit
        .mockResolvedValueOnce([{ role: "member" }]) // requireOrgAccess
        .mockResolvedValueOnce([{ ownerId: "user-1" }]) // requireWorkspaceAccess
        .mockResolvedValueOnce([]); // no webhook

      const res = await app.request(baseUrl);
      expect(res.status).toBe(404);
    });
  });

  describe("PUT /", () => {
    it("should update webhook and return sanitized response", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]); // requireWorkspaceAccess

      mockDb.returning.mockResolvedValueOnce([
        {
          id: "wh-1",
          workspaceId,
          url: "https://new-url.com/webhook",
          signingSecret: "secret",
          headers: { "X-Custom": "value" },
          enabled: false,
          events: ["notification.created"],
        },
      ]);

      const res = await app.request(baseUrl, {
        method: "PUT",
        body: JSON.stringify({
          url: "https://new-url.com/webhook",
          enabled: false,
        }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.url).toBe("https://new-url.com/webhook");
      expect(data.headers).toEqual({ "X-Custom": "value" });
    });
  });

  describe("DELETE /", () => {
    it("should delete webhook", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]); // requireWorkspaceAccess

      mockDb.returning.mockResolvedValueOnce([{ id: "wh-1" }]);

      const res = await app.request(baseUrl, {
        method: "DELETE",
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ message: "Webhook deleted" });
    });
  });

  describe("POST /regenerate-secret", () => {
    it("should regenerate signing secret and return full record", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]); // requireWorkspaceAccess

      const newWebhook = {
        id: "wh-1",
        workspaceId,
        url: "https://example.com/webhook",
        signingSecret: "new-secret",
        headers: null,
        enabled: true,
        events: [
          "notification.created",
          "notification.updated",
          "notification.read",
          "notification.dismissed",
        ],
      };
      mockDb.returning.mockResolvedValueOnce([newWebhook]);

      const res = await app.request(`${baseUrl}/regenerate-secret`, {
        method: "POST",
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.signingSecret).toBe("new-secret");
    });
  });
});
