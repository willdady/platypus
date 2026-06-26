import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockDb, resetMockDb } from "../test-utils.ts";

vi.mock("../services/event-dispatch.ts", () => ({
  dispatchEvent: vi.fn(),
}));

import { createNotificationTools } from "./notification.ts";
import { dispatchEvent } from "../services/event-dispatch.ts";

const ctx = { toolCallId: "test", messages: [] };
const workspaceId = "ws-1";
const agentId = "agent-1";
const orgId = "org-1";

describe("createNotificationTools", () => {
  let tools: ReturnType<typeof createNotificationTools>;

  beforeEach(() => {
    vi.clearAllMocks();
    resetMockDb();
    tools = createNotificationTools(workspaceId, agentId, orgId);
  });

  it("returns the expected tool names", () => {
    expect(Object.keys(tools)).toEqual([
      "createNotification",
      "listNotifications",
      "updateNotification",
      "deleteNotification",
    ]);
  });

  describe("createNotification", () => {
    it("inserts a notification and dispatches event", async () => {
      const record = {
        id: "notif-1",
        workspaceId,
        agentId,
        title: "Test",
        body: "Hello",
      };
      mockDb.returning.mockResolvedValue([record]);

      expect(
        await tools.createNotification.execute!(
          { title: "Test", body: "Hello" },
          ctx,
        ),
      ).toEqual(record);
      expect(dispatchEvent).toHaveBeenCalledWith(
        orgId,
        workspaceId,
        "notification.created",
        record,
      );
    });
  });

  describe("listNotifications", () => {
    it("returns notifications with default limit", async () => {
      const notifications = [
        { id: "n1", body: "First" },
        { id: "n2", body: "Second" },
      ];
      mockDb.limit.mockResolvedValue(notifications);

      expect(await tools.listNotifications.execute!({}, ctx)).toEqual(
        notifications,
      );
    });
  });

  describe("updateNotification", () => {
    it("returns error when notification not found", async () => {
      mockDb.limit.mockResolvedValue([]);

      expect(
        await tools.updateNotification.execute!(
          { notificationId: "bad-id", body: "Updated" },
          ctx,
        ),
      ).toEqual({ error: "Notification not found" });
    });

    it("updates and dispatches event when found", async () => {
      const updated = { id: "n1", body: "Updated" };
      mockDb.limit.mockResolvedValue([{ id: "n1" }]);
      mockDb.returning.mockResolvedValue([updated]);

      expect(
        await tools.updateNotification.execute!(
          { notificationId: "n1", body: "Updated" },
          ctx,
        ),
      ).toEqual(updated);
      expect(dispatchEvent).toHaveBeenCalledWith(
        orgId,
        workspaceId,
        "notification.updated",
        updated,
      );
    });
  });

  describe("deleteNotification", () => {
    it("returns error when notification not found", async () => {
      mockDb.limit.mockResolvedValue([]);

      expect(
        await tools.deleteNotification.execute!(
          { notificationId: "bad-id" },
          ctx,
        ),
      ).toEqual({ error: "Notification not found" });
    });

    it("deletes and dispatches event when found", async () => {
      mockDb.limit.mockResolvedValue([{ id: "n1" }]);

      expect(
        await tools.deleteNotification.execute!({ notificationId: "n1" }, ctx),
      ).toEqual({ success: true });
      expect(dispatchEvent).toHaveBeenCalledWith(
        orgId,
        workspaceId,
        "notification.dismissed",
        { notificationId: "n1" },
      );
    });
  });
});
