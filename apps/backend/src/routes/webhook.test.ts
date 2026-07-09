import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockDb, mockSession, resetMockDb } from "../test-utils.ts";
import app from "../server.ts";

// Mock crypto.randomBytes for predictable signing secrets
vi.mock("node:crypto", async () => {
  const actual =
    await vi.importActual<typeof import("node:crypto")>("node:crypto");
  const actualDefault: typeof import("node:crypto") = (
    actual as unknown as { default: typeof import("node:crypto") }
  ).default;
  return {
    ...actual,
    default: {
      ...actualDefault,
      randomBytes: vi.fn().mockReturnValue(Buffer.from("a".repeat(32))),
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
  const baseUrl = `/organizations/${orgId}/workspaces/${workspaceId}/webhooks`;

  describe("GET /", () => {
    it("should return list of webhooks", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]); // requireWorkspaceAccess

      const mockWebhooks = [
        {
          id: "wh-1",
          workspaceId,
          name: "My Webhook",
          url: "https://example.com/webhook",
          signingSecret: "secret",
          headers: null,
          enabled: true,
          events: ["notification.created"],
        },
        {
          id: "wh-2",
          workspaceId,
          name: "Second Webhook",
          url: "https://example.com/webhook2",
          signingSecret: "secret2",
          headers: null,
          enabled: false,
          events: ["notification.created", "notification.updated"],
        },
      ];
      // Middleware calls where().limit(), so where returns mockDb for those.
      // The route's where() (3rd call) must resolve directly since there's no .limit().
      mockDb.where
        .mockReturnValueOnce(mockDb) // requireOrgAccess
        .mockReturnValueOnce(mockDb) // requireWorkspaceAccess
        .mockResolvedValueOnce(mockWebhooks); // route handler

      const res = await app.request(baseUrl);
      expect(res.status).toBe(200);
      const data = (await res.json()) as { results: { name: string }[] };
      expect(data.results).toHaveLength(2);
      expect(data.results[0].name).toBe("My Webhook");
      expect(data.results[1].name).toBe("Second Webhook");
    });

    it("should return empty results when no webhooks exist", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]); // requireWorkspaceAccess

      mockDb.where
        .mockReturnValueOnce(mockDb) // requireOrgAccess
        .mockReturnValueOnce(mockDb) // requireWorkspaceAccess
        .mockResolvedValueOnce([]); // route handler

      const res = await app.request(baseUrl);
      expect(res.status).toBe(200);
      const data = (await res.json()) as { results: unknown[] };
      expect(data.results).toHaveLength(0);
    });
  });

  describe("POST /", () => {
    it("should create webhook and return 201", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]); // requireWorkspaceAccess

      const mockWebhook = {
        id: "wh-1",
        workspaceId,
        name: "My Webhook",
        url: "https://example.com/webhook",
        signingSecret: "secret",
        headers: null,
        enabled: true,
        events: [
          "notification.created",
          "notification.updated",
          "notification.read",
          "notification.dismissed",
          "card.created",
          "card.updated",
          "card.deleted",
        ],
      };
      mockDb.returning.mockResolvedValueOnce([mockWebhook]);

      const res = await app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify({
          name: "My Webhook",
          url: "https://example.com/webhook",
        }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(201);
      const data = (await res.json()) as { url: string; name: string };
      expect(data.url).toBe("https://example.com/webhook");
      expect(data.name).toBe("My Webhook");
    });
  });

  describe("GET /:webhookId", () => {
    it("should return a single webhook", async () => {
      mockSession();
      mockDb.limit
        .mockResolvedValueOnce([{ role: "member" }]) // requireOrgAccess
        .mockResolvedValueOnce([{ ownerId: "user-1", organizationId: "org-1" }]) // requireWorkspaceAccess
        .mockResolvedValueOnce([
          {
            id: "wh-1",
            workspaceId,
            name: "My Webhook",
            url: "https://example.com/webhook",
            signingSecret: "secret",
            headers: { Authorization: "Bearer real-token" },
            enabled: true,
            events: ["notification.created"],
          },
        ]);

      const res = await app.request(`${baseUrl}/wh-1`);
      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        name: string;
        headers: Record<string, string>;
      };
      expect(data.name).toBe("My Webhook");
      expect(data.headers).toEqual({ Authorization: "Bearer real-token" });
    });

    it("should return 404 for non-existent webhook", async () => {
      mockSession();
      mockDb.limit
        .mockResolvedValueOnce([{ role: "member" }]) // requireOrgAccess
        .mockResolvedValueOnce([{ ownerId: "user-1", organizationId: "org-1" }]) // requireWorkspaceAccess
        .mockResolvedValueOnce([]); // no webhook

      const res = await app.request(`${baseUrl}/nonexistent`);
      expect(res.status).toBe(404);
    });
  });

  describe("PUT /:webhookId", () => {
    it("should update webhook", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]); // requireWorkspaceAccess

      mockDb.returning.mockResolvedValueOnce([
        {
          id: "wh-1",
          workspaceId,
          name: "Updated Webhook",
          url: "https://new-url.com/webhook",
          signingSecret: "secret",
          headers: { "X-Custom": "value" },
          enabled: false,
          events: ["notification.created"],
        },
      ]);

      const res = await app.request(`${baseUrl}/wh-1`, {
        method: "PUT",
        body: JSON.stringify({
          name: "Updated Webhook",
          url: "https://new-url.com/webhook",
          enabled: false,
        }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as { name: string; url: string };
      expect(data.name).toBe("Updated Webhook");
      expect(data.url).toBe("https://new-url.com/webhook");
    });

    it("should return 404 for non-existent webhook", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]); // requireWorkspaceAccess

      mockDb.returning.mockResolvedValueOnce([]);

      const res = await app.request(`${baseUrl}/nonexistent`, {
        method: "PUT",
        body: JSON.stringify({
          url: "https://new-url.com/webhook",
        }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /:webhookId", () => {
    it("should delete webhook", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]); // requireWorkspaceAccess

      mockDb.returning.mockResolvedValueOnce([{ id: "wh-1" }]);

      const res = await app.request(`${baseUrl}/wh-1`, {
        method: "DELETE",
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ message: "Webhook deleted" });
    });

    it("should return 404 for non-existent webhook", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]); // requireWorkspaceAccess

      mockDb.returning.mockResolvedValueOnce([]);

      const res = await app.request(`${baseUrl}/nonexistent`, {
        method: "DELETE",
      });

      expect(res.status).toBe(404);
    });
  });

  describe("POST /:webhookId/regenerate-secret", () => {
    it("should regenerate signing secret and return full record", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]); // requireWorkspaceAccess

      const newWebhook = {
        id: "wh-1",
        workspaceId,
        name: "My Webhook",
        url: "https://example.com/webhook",
        signingSecret: "new-secret",
        headers: null,
        enabled: true,
        events: [
          "notification.created",
          "notification.updated",
          "notification.read",
          "notification.dismissed",
          "card.created",
          "card.updated",
          "card.deleted",
        ],
      };
      mockDb.returning.mockResolvedValueOnce([newWebhook]);

      const res = await app.request(`${baseUrl}/wh-1/regenerate-secret`, {
        method: "POST",
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as { signingSecret: string };
      expect(data.signingSecret).toBe("new-secret");
    });

    it("should return 404 for non-existent webhook", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]); // requireWorkspaceAccess

      mockDb.returning.mockResolvedValueOnce([]);

      const res = await app.request(
        `${baseUrl}/nonexistent/regenerate-secret`,
        {
          method: "POST",
        },
      );

      expect(res.status).toBe(404);
    });
  });
});
