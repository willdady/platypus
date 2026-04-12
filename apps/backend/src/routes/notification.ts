import { Hono } from "hono";
import { nanoid } from "nanoid";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "../index.ts";
import {
  notification as notificationTable,
  notificationRead as notificationReadTable,
  agent as agentTable,
} from "../db/schema.ts";
import { requireAuth } from "../middleware/authentication.ts";
import {
  requireOrgAccess,
  requireWorkspaceAccess,
} from "../middleware/authorization.ts";
import type { Variables } from "../server.ts";
import { dispatchEvent } from "../services/webhook-delivery.ts";
import { avatarKeyToUrl } from "../utils/avatar-url.ts";

const notification = new Hono<{ Variables: Variables }>();

/** List notifications for workspace */
notification.get(
  "/",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  async (c) => {
    const workspaceId = c.req.param("workspaceId")!;
    const user = c.get("user")!;
    const limit = Math.min(
      Math.max(parseInt(c.req.query("limit") || "50", 10) || 50, 1),
      100,
    );
    const offset = Math.max(parseInt(c.req.query("offset") || "0", 10) || 0, 0);
    const baseUrl =
      process.env.BETTER_AUTH_URL ||
      `http://localhost:${process.env.PORT || 4000}`;

    const results = await db
      .select({
        id: notificationTable.id,
        workspaceId: notificationTable.workspaceId,
        agentId: notificationTable.agentId,
        title: notificationTable.title,
        body: notificationTable.body,
        createdAt: notificationTable.createdAt,
        updatedAt: notificationTable.updatedAt,
        agentName: agentTable.name,
        agentAvatarKey: agentTable.avatarKey,
        readAt: notificationReadTable.readAt,
      })
      .from(notificationTable)
      .innerJoin(agentTable, eq(notificationTable.agentId, agentTable.id))
      .leftJoin(
        notificationReadTable,
        and(
          eq(notificationReadTable.notificationId, notificationTable.id),
          eq(notificationReadTable.userId, user.id),
        ),
      )
      .where(eq(notificationTable.workspaceId, workspaceId))
      .orderBy(desc(notificationTable.createdAt))
      .limit(limit)
      .offset(offset);

    return c.json({
      results: results.map((r) => ({
        id: r.id,
        workspaceId: r.workspaceId,
        agentId: r.agentId,
        title: r.title,
        body: r.body,
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
    const workspaceId = c.req.param("workspaceId")!;
    const user = c.get("user")!;

    const result = await db
      .select({
        count: sql<number>`count(*)::int`,
      })
      .from(notificationTable)
      .leftJoin(
        notificationReadTable,
        and(
          eq(notificationReadTable.notificationId, notificationTable.id),
          eq(notificationReadTable.userId, user.id),
        ),
      )
      .where(
        and(
          eq(notificationTable.workspaceId, workspaceId),
          isNull(notificationReadTable.id),
        ),
      );

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
    const user = c.get("user")!;
    const workspaceId = c.req.param("workspaceId")!;

    // Verify notification exists in this workspace
    const existing = await db
      .select({ id: notificationTable.id })
      .from(notificationTable)
      .where(
        and(
          eq(notificationTable.id, notificationId),
          eq(notificationTable.workspaceId, workspaceId),
        ),
      )
      .limit(1);

    if (existing.length === 0) {
      return c.json({ message: "Notification not found" }, 404);
    }

    await db
      .insert(notificationReadTable)
      .values({
        id: nanoid(),
        notificationId,
        userId: user.id,
      })
      .onConflictDoNothing();

    dispatchEvent(workspaceId, "notification.read", {
      notificationId,
      userId: user.id,
    });

    return c.json({ success: true });
  },
);

/** Mark all workspace notifications as read */
notification.post(
  "/read-all",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  async (c) => {
    const workspaceId = c.req.param("workspaceId")!;
    const user = c.get("user")!;

    // Get all unread notification IDs
    const unread = await db
      .select({ id: notificationTable.id })
      .from(notificationTable)
      .leftJoin(
        notificationReadTable,
        and(
          eq(notificationReadTable.notificationId, notificationTable.id),
          eq(notificationReadTable.userId, user.id),
        ),
      )
      .where(
        and(
          eq(notificationTable.workspaceId, workspaceId),
          isNull(notificationReadTable.id),
        ),
      );

    if (unread.length > 0) {
      await db.insert(notificationReadTable).values(
        unread.map((n) => ({
          id: nanoid(),
          notificationId: n.id,
          userId: user.id,
        })),
      );

      dispatchEvent(workspaceId, "notification.read", {
        notificationIds: unread.map((n) => n.id),
        userId: user.id,
        bulk: true,
      });
    }

    return c.json({ success: true });
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
    const workspaceId = c.req.param("workspaceId")!;

    const result = await db
      .delete(notificationTable)
      .where(
        and(
          eq(notificationTable.id, notificationId),
          eq(notificationTable.workspaceId, workspaceId),
        ),
      )
      .returning();

    if (result.length === 0) {
      return c.json({ message: "Notification not found" }, 404);
    }

    dispatchEvent(workspaceId, "notification.dismissed", {
      notificationId,
    });

    return c.json({ message: "Notification deleted" });
  },
);

export { notification };
