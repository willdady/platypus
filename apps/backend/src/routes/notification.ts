import { Hono } from "hono";
import { db } from "../index.ts";
import { requireAuth } from "../middleware/authentication.ts";
import {
  requireOrgAccess,
  requireWorkspaceAccess,
  workspaceScopeOf,
  userOf,
} from "../middleware/authorization.ts";
import {
  markRead,
  markAllRead,
  deleteNotification,
  listWorkspaceNotifications,
  notificationSource,
  unreadNotificationCount,
} from "../services/notification.ts";
import { NotFoundError } from "../errors.ts";
import type { Variables } from "../server.ts";
import { avatarKeyToUrl } from "../utils/avatar-url.ts";
import { getOrigin } from "../utils/get-origin.ts";

const notification = new Hono<{ Variables: Variables }>();

/** List notifications for workspace */
notification.get(
  "/",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  async (c) => {
    const { workspaceId } = workspaceScopeOf(c);
    const user = userOf(c);
    const limit = Math.min(
      Math.max(parseInt(c.req.query("limit") ?? "50", 10) || 50, 1),
      100,
    );
    const offset = Math.max(parseInt(c.req.query("offset") ?? "0", 10) || 0, 0);
    const baseUrl = getOrigin(c);

    const results = await listWorkspaceNotifications(
      db,
      workspaceId,
      user.id,
      limit,
      offset,
    );

    return c.json({
      results: results.map((r) => ({
        id: r.id,
        workspaceId: r.workspaceId,
        agentId: r.agentId,
        title: r.title,
        body: r.body,
        source: notificationSource(r),
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        agentName: r.agentName,
        agentAvatarUrl: avatarKeyToUrl(r.agentAvatarKey, baseUrl) ?? undefined,
        isRead: r.readAt !== null,
      })),
    });
  },
);

/** Get unread notification count */
notification.get(
  "/unread-count",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  async (c) => {
    const { workspaceId } = workspaceScopeOf(c);
    const user = userOf(c);

    const result = await unreadNotificationCount(db, workspaceId, user.id);

    return c.json({ count: result[0]?.count ?? 0 });
  },
);

/** Mark a single notification as read */
notification.post(
  "/:notificationId/read",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  async (c) => {
    const notificationId = c.req.param("notificationId");
    const user = userOf(c);
    const { orgId, workspaceId } = workspaceScopeOf(c);

    if (
      !(await markRead(db, { orgId, workspaceId }, notificationId, user.id))
    ) {
      throw new NotFoundError("Notification not found");
    }

    return c.json({ message: "Notification marked as read" });
  },
);

/** Mark all workspace notifications as read */
notification.post(
  "/read-all",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  async (c) => {
    const { orgId, workspaceId } = workspaceScopeOf(c);
    const user = userOf(c);

    await markAllRead(db, { orgId, workspaceId }, user.id);

    return c.json({ message: "All notifications marked as read" });
  },
);

/** Delete a notification */
notification.delete(
  "/:notificationId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  async (c) => {
    const notificationId = c.req.param("notificationId");
    const { orgId, workspaceId } = workspaceScopeOf(c);

    const deleted = await deleteNotification(
      db,
      { orgId, workspaceId },
      notificationId,
    );

    if (!deleted) {
      throw new NotFoundError("Notification not found");
    }

    return c.json({ message: "Notification deleted" });
  },
);

export { notification };
