import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  mockDb,
  mockSession,
  mockNoSession,
  resetMockDb,
} from "../test-utils.ts";
import app from "../server.ts";

// Mock nanoid to return predictable IDs
vi.mock("nanoid", () => ({
  nanoid: vi.fn(() => "test-id-123"),
  customAlphabet: vi.fn(() => vi.fn(() => "ABC123")),
}));

describe("Notification Routes", () => {
  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
    mockDb.where.mockReturnValue(mockDb);
  });

  const orgId = "org-1";
  const workspaceId = "ws-1";
  const baseUrl = `/organizations/${orgId}/workspaces/${workspaceId}/notifications`;

  describe("GET /", () => {
    it("should return 401 if not authenticated", async () => {
      mockNoSession();
      const res = await app.request(baseUrl);
      expect(res.status).toBe(401);
    });

    it("should return notifications with agent name, avatar URL, and read status", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]); // requireWorkspaceAccess

      const mockNotifications = [
        {
          id: "notif-1",
          workspaceId,
          agentId: "agent-1",
          title: "Report Ready",
          body: "Your report is ready.",
          createdAt: new Date(),
          updatedAt: new Date(),
          agentName: "My Agent",
          agentAvatarKey: null,
          readAt: null,
        },
      ];
      mockDb.offset.mockResolvedValueOnce(mockNotifications);

      const res = await app.request(baseUrl);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.results).toHaveLength(1);
      expect(body.results[0].agentName).toBe("My Agent");
      expect(body.results[0].isRead).toBe(false);
      expect(body.results[0].agentAvatarUrl).toBeUndefined();
    });

    it("should return empty array when no notifications exist", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]); // requireWorkspaceAccess
      mockDb.offset.mockResolvedValueOnce([]);

      const res = await app.request(baseUrl);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.results).toHaveLength(0);
    });
  });

  describe("GET /unread-count", () => {
    it("should return 401 if not authenticated", async () => {
      mockNoSession();
      const res = await app.request(`${baseUrl}/unread-count`);
      expect(res.status).toBe(401);
    });

    it("should return correct unread count", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]); // requireWorkspaceAccess
      // where() is used by middleware (sync chaining) then by handler (terminal)
      mockDb.where
        .mockReturnValueOnce(mockDb) // requireOrgAccess
        .mockReturnValueOnce(mockDb) // requireWorkspaceAccess
        .mockResolvedValueOnce([{ count: 3 }]); // handler query

      const res = await app.request(`${baseUrl}/unread-count`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.count).toBe(3);
    });

    it("should return 0 when all notifications read", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]); // requireWorkspaceAccess
      mockDb.where
        .mockReturnValueOnce(mockDb) // requireOrgAccess
        .mockReturnValueOnce(mockDb) // requireWorkspaceAccess
        .mockResolvedValueOnce([{ count: 0 }]); // handler query

      const res = await app.request(`${baseUrl}/unread-count`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.count).toBe(0);
    });
  });

  describe("POST /:notificationId/read", () => {
    it("should return 401 if not authenticated", async () => {
      mockNoSession();
      const res = await app.request(`${baseUrl}/notif-1/read`, {
        method: "POST",
      });
      expect(res.status).toBe(401);
    });

    it("should mark notification as read", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]); // requireWorkspaceAccess
      mockDb.limit.mockResolvedValueOnce([{ id: "notif-1" }]); // notification exists

      // onConflictDoNothing returns the mock chain
      mockDb.onConflictDoNothing = vi.fn().mockResolvedValueOnce({});
      mockDb.values.mockReturnValueOnce(mockDb);

      const res = await app.request(`${baseUrl}/notif-1/read`, {
        method: "POST",
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
    });

    it("should return 404 if notification does not exist", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]); // requireWorkspaceAccess
      mockDb.limit.mockResolvedValueOnce([]); // notification not found

      const res = await app.request(`${baseUrl}/notif-1/read`, {
        method: "POST",
      });
      expect(res.status).toBe(404);
    });
  });

  describe("POST /read-all", () => {
    it("should return 401 if not authenticated", async () => {
      mockNoSession();
      const res = await app.request(`${baseUrl}/read-all`, {
        method: "POST",
      });
      expect(res.status).toBe(401);
    });

    it("should mark all workspace notifications as read", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]); // requireWorkspaceAccess

      // where() is used by middleware (sync chaining) then by handler (terminal)
      mockDb.where
        .mockReturnValueOnce(mockDb) // requireOrgAccess
        .mockReturnValueOnce(mockDb) // requireWorkspaceAccess
        .mockResolvedValueOnce([{ id: "notif-1" }, { id: "notif-2" }]); // handler unread query

      // Insert read records
      mockDb.values.mockResolvedValueOnce({});

      const res = await app.request(`${baseUrl}/read-all`, {
        method: "POST",
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
    });
  });

  describe("DELETE /:notificationId", () => {
    it("should return 401 if not authenticated", async () => {
      mockNoSession();
      const res = await app.request(`${baseUrl}/notif-1`, {
        method: "DELETE",
      });
      expect(res.status).toBe(401);
    });

    it("should delete notification successfully", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]); // requireWorkspaceAccess
      mockDb.returning.mockResolvedValueOnce([{ id: "notif-1" }]);

      const res = await app.request(`${baseUrl}/notif-1`, {
        method: "DELETE",
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.message).toBe("Notification deleted");
    });

    it("should return 404 if notification does not exist", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]); // requireWorkspaceAccess
      mockDb.returning.mockResolvedValueOnce([]);

      const res = await app.request(`${baseUrl}/notif-1`, {
        method: "DELETE",
      });
      expect(res.status).toBe(404);
    });
  });
});
