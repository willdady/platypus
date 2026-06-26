import { tool, type Tool } from "ai";
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../index.ts";
import { notification as notificationTable } from "../db/schema.ts";
import { dispatchEvent } from "../services/event-dispatch.ts";

export function createNotificationTools(
  workspaceId: string,
  agentId: string,
  orgId: string,
): Record<string, Tool> {
  async function verifyNotification(notificationId: string): Promise<boolean> {
    const result = await db
      .select({ id: notificationTable.id })
      .from(notificationTable)
      .where(
        and(
          eq(notificationTable.id, notificationId),
          eq(notificationTable.agentId, agentId),
          eq(notificationTable.workspaceId, workspaceId),
        ),
      )
      .limit(1);
    return result.length > 0;
  }

  const createNotification = tool({
    description:
      "Create a notification visible to users in this workspace. Supports minimal markdown in the body.",
    inputSchema: z.object({
      title: z
        .string()
        .max(200)
        .optional()
        .describe("Optional short title for the notification"),
      body: z
        .string()
        .min(1)
        .max(2000)
        .describe("The notification body (supports markdown)"),
    }),
    execute: async ({ title, body }) => {
      const { nanoid } = await import("nanoid");
      const id = nanoid();
      const now = new Date();
      const normalizedBody = body.replace(/\\n/g, "\n").replace(/\\t/g, "\t");

      const record = await db
        .insert(notificationTable)
        .values({
          id,
          workspaceId,
          agentId,
          title: title ?? null,
          body: normalizedBody,
          createdAt: now,
          updatedAt: now,
        })
        .returning();

      dispatchEvent(orgId, workspaceId, "notification.created", record[0]);

      return record[0];
    },
  });

  const listNotifications = tool({
    description: "List this agent's recent notifications in the workspace.",
    inputSchema: z.object({
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("Maximum number of notifications to return (default 20)"),
    }),
    execute: async ({ limit }) => {
      const notifications = await db
        .select()
        .from(notificationTable)
        .where(
          and(
            eq(notificationTable.workspaceId, workspaceId),
            eq(notificationTable.agentId, agentId),
          ),
        )
        .orderBy(desc(notificationTable.createdAt))
        .limit(limit ?? 20);
      return notifications;
    },
  });

  const updateNotification = tool({
    description: "Update a notification this agent created.",
    inputSchema: z.object({
      notificationId: z
        .string()
        .describe("The ID of the notification to update"),
      title: z
        .string()
        .max(200)
        .optional()
        .describe("New title for the notification"),
      body: z
        .string()
        .min(1)
        .max(2000)
        .optional()
        .describe("New body for the notification"),
    }),
    execute: async ({ notificationId, title, body }) => {
      if (!(await verifyNotification(notificationId))) {
        return { error: "Notification not found" };
      }

      const updateData: Record<string, unknown> = {
        updatedAt: new Date(),
      };
      if (title !== undefined) updateData.title = title;
      if (body !== undefined)
        updateData.body = body.replace(/\\n/g, "\n").replace(/\\t/g, "\t");

      const record = await db
        .update(notificationTable)
        .set(updateData)
        .where(eq(notificationTable.id, notificationId))
        .returning();

      if (record.length === 0) {
        return { error: "Notification not found" };
      }

      dispatchEvent(orgId, workspaceId, "notification.updated", record[0]);

      return record[0];
    },
  });

  const deleteNotification = tool({
    description: "Delete a notification this agent created.",
    inputSchema: z.object({
      notificationId: z
        .string()
        .describe("The ID of the notification to delete"),
    }),
    execute: async ({ notificationId }) => {
      if (!(await verifyNotification(notificationId))) {
        return { error: "Notification not found" };
      }

      await db
        .delete(notificationTable)
        .where(eq(notificationTable.id, notificationId));

      dispatchEvent(orgId, workspaceId, "notification.dismissed", {
        notificationId,
      });

      return { success: true };
    },
  });

  return {
    createNotification,
    listNotifications,
    updateNotification,
    deleteNotification,
  };
}
