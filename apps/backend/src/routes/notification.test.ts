import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  mockSession,
  mockNoSession,
  resetMockDb,
  seedDb,
  type FakeDb,
  type Row,
} from "../test-utils.ts";
import {
  markAllRead,
  unreadNotificationCount,
} from "../services/notification.ts";
import app from "../server.ts";

vi.mock("../services/notification.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../services/notification.ts")>();
  return {
    ...actual,
    unreadNotificationCount: vi.fn(actual.unreadNotificationCount),
    markAllRead: vi.fn(actual.markAllRead),
  };
});

const realNotification = await vi.importActual<
  typeof import("../services/notification.ts")
>("../services/notification.ts");

describe("Notification Routes", () => {
  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
    vi.mocked(unreadNotificationCount).mockImplementation(
      realNotification.unreadNotificationCount,
    );
    vi.mocked(markAllRead).mockImplementation(realNotification.markAllRead);
  });

  const orgId = "org-1";
  const workspaceId = "ws-1";
  const baseUrl = `/organizations/${orgId}/workspaces/${workspaceId}/notifications`;

  const notificationRow = (over: Row = {}): Row => ({
    id: "notif-1",
    workspaceId,
    agentId: "agent-1",
    title: "Report Ready",
    body: "Your report is ready.",
    sourceChatId: null,
    sourceTriggerRunId: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...over,
  });

  const agentRow = (over: Row = {}): Row => ({
    id: "agent-1",
    workspaceId,
    organizationId: null,
    name: "My Agent",
    avatarKey: null,
    ...over,
  });

  const world = (
    options: { notifications?: Row[]; reads?: Row[] } = {},
  ): FakeDb => {
    const { notifications = [notificationRow()], reads = [] } = options;
    return seedDb({
      organization_member: [
        { id: "m1", userId: "user-1", organizationId: orgId, role: "member" },
      ],
      workspace: [
        {
          id: workspaceId,
          name: "Support",
          organizationId: orgId,
          ownerId: "user-1",
        },
        {
          id: "ws-2",
          name: "Billing",
          organizationId: orgId,
          ownerId: "user-1",
        },
      ],
      agent: [agentRow(), agentRow({ id: "agent-2", name: "Other Agent" })],
      notification: [
        ...notifications,
        notificationRow({ id: "notif-elsewhere", workspaceId: "ws-2" }),
      ],
      notification_read: reads,
    });
  };

  describe("GET /", () => {
    it("should return 401 if not authenticated", async () => {
      mockNoSession();
      const res = await app.request(baseUrl);
      expect(res.status).toBe(401);
    });

    it("should return notifications with agent name, avatar URL, and read status", async () => {
      mockSession();
      world();

      const res = await app.request(baseUrl);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        results: {
          agentName: string;
          isRead: boolean;
          agentAvatarUrl?: string;
        }[];
      };
      expect(body.results).toHaveLength(1);
      expect(body.results[0].agentName).toBe("My Agent");
      expect(body.results[0].isRead).toBe(false);
      expect(body.results[0].agentAvatarUrl).toBeUndefined();
    });

    it("returns each notification's source, null when it has none", async () => {
      mockSession();
      world({
        notifications: [
          notificationRow({
            id: "n-chat",
            title: null,
            body: "n-chat",
            sourceChatId: "chat-1",
            createdAt: new Date("2026-01-03T00:00:00.000Z"),
          }),
          notificationRow({
            id: "n-run",
            title: null,
            body: "n-run",
            sourceTriggerRunId: "run-1",
            createdAt: new Date("2026-01-02T00:00:00.000Z"),
          }),
          notificationRow({
            id: "n-none",
            title: null,
            body: "n-none",
            createdAt: new Date("2026-01-01T00:00:00.000Z"),
          }),
        ],
      });

      const res = await app.request(baseUrl);
      const body = (await res.json()) as { results: { source: unknown }[] };
      expect(body.results.map((r) => r.source)).toEqual([
        { kind: "chat", chatId: "chat-1" },
        { kind: "triggerRun", triggerRunId: "run-1" },
        null,
      ]);
    });

    it("should return empty array when no notifications exist", async () => {
      mockSession();
      world({ notifications: [] });

      const res = await app.request(baseUrl);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.results).toHaveLength(0);
    });

    it("defaults to the first 50 notifications", async () => {
      mockSession();
      world({
        notifications: Array.from({ length: 60 }, (_, index) =>
          notificationRow({
            id: `n-${String(index).padStart(2, "0")}`,
            body: `n-${index}`,
            createdAt: new Date(Date.UTC(2026, 0, 1, 0, index)),
          }),
        ),
      });

      const res = await app.request(baseUrl);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { results: { id: string }[] };
      expect(body.results).toHaveLength(50);
      expect(body.results[0].id).toBe("n-59");
      expect(body.results.at(-1)?.id).toBe("n-10");
    });

    it.each(["limit=0", "limit=101", "limit=abc", "limit=1.5", "offset=-1"])(
      "rejects %s with a 400",
      async (query) => {
        mockSession();
        const fake = world();

        const res = await app.request(`${baseUrl}?${query}`);
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error?: unknown };
        expect(Object.keys(body)).toEqual(["error"]);
        expect(fake.queries.some((q) => q.table === "notification")).toBe(
          false,
        );
      },
    );
  });

  describe("GET /unread-count", () => {
    it("should return 401 if not authenticated", async () => {
      mockNoSession();
      const res = await app.request(`${baseUrl}/unread-count`);
      expect(res.status).toBe(401);
    });

    it("should return correct unread count", async () => {
      mockSession();
      world({
        notifications: [
          notificationRow({ id: "notif-1" }),
          notificationRow({ id: "notif-2" }),
          notificationRow({ id: "notif-3" }),
          notificationRow({ id: "notif-read" }),
        ],
        reads: [
          {
            id: "read-1",
            notificationId: "notif-read",
            userId: "user-1",
            readAt: new Date("2026-01-02T00:00:00.000Z"),
          },
        ],
      });
      const res = await app.request(`${baseUrl}/unread-count`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.count).toBe(3);
      expect(unreadNotificationCount).toHaveBeenCalledWith(
        expect.anything(),
        workspaceId,
        "user-1",
      );
    });

    it("should return 0 when all notifications read", async () => {
      mockSession();
      world({
        notifications: [notificationRow({ id: "notif-1" })],
        reads: [
          {
            id: "read-1",
            notificationId: "notif-1",
            userId: "user-1",
            readAt: new Date("2026-01-02T00:00:00.000Z"),
          },
        ],
      });

      const res = await app.request(`${baseUrl}/unread-count`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
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
      const fake = world();

      const res = await app.request(`${baseUrl}/notif-1/read`, {
        method: "POST",
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        message: "Notification marked as read",
      });
      expect(fake.tables.notification_read).toEqual([
        {
          id: expect.any(String) as unknown,
          notificationId: "notif-1",
          userId: "user-1",
        },
      ]);
    });

    it("should return 404 if notification does not exist", async () => {
      mockSession();
      const fake = world({
        notifications: [
          notificationRow({ id: "notif-1", workspaceId: "ws-2" }),
        ],
      });

      const res = await app.request(`${baseUrl}/notif-1/read`, {
        method: "POST",
      });
      expect(res.status).toBe(404);
      expect(fake.tables.notification_read).toEqual([]);
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
      world({
        notifications: [
          notificationRow({ id: "notif-1" }),
          notificationRow({ id: "notif-2" }),
        ],
      });
      vi.mocked(markAllRead).mockResolvedValue(undefined);

      const res = await app.request(`${baseUrl}/read-all`, {
        method: "POST",
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        message: "All notifications marked as read",
      });
      expect(markAllRead).toHaveBeenCalledWith(
        expect.anything(),
        { orgId, workspaceId },
        "user-1",
      );
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
      const fake = world();

      const res = await app.request(`${baseUrl}/notif-1`, {
        method: "DELETE",
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.message).toBe("Notification deleted");
      expect(fake.tables.notification.map((n) => n.id)).toEqual([
        "notif-elsewhere",
      ]);
    });

    it("should return 404 if notification does not exist", async () => {
      mockSession();
      const fake = world({
        notifications: [
          notificationRow({ id: "notif-1", workspaceId: "ws-2" }),
        ],
      });

      const res = await app.request(`${baseUrl}/notif-1`, {
        method: "DELETE",
      });
      expect(res.status).toBe(404);
      expect(fake.tables.notification.map((n) => n.id)).toEqual([
        "notif-1",
        "notif-elsewhere",
      ]);
    });
  });
});
