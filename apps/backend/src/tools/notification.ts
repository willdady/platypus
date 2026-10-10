import { tool, type Tool } from "ai";
import { z } from "zod";
import { db } from "../index.ts";
import {
  createNotification,
  deleteNotification,
  listNotifications,
  updateNotification,
} from "../services/notification.ts";

// The Agent has no use for its own Chat or run id; Webhooks and the API carry it.
const withoutSource = <T extends { source: unknown }>({
  source: _source,
  ...rest
}: T) => rest;

export function createNotificationTools(
  workspaceId: string,
  agentId: string,
  orgId: string,
): Record<string, Tool> {
  const ctx = { workspaceId, agentId, orgId };
  const create = tool({
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
    execute: async ({ title, body }) =>
      withoutSource(await createNotification(db, ctx, { title, body })),
  });
  const list = tool({
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
    execute: async ({ limit }) =>
      (await listNotifications(db, ctx, limit ?? 20)).map(withoutSource),
  });
  const update = tool({
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
      const result = await updateNotification(db, ctx, notificationId, {
        title,
        body,
      });
      return result
        ? withoutSource(result)
        : { error: "Notification not found" };
    },
  });
  const remove = tool({
    description: "Delete a notification this agent created.",
    inputSchema: z.object({
      notificationId: z
        .string()
        .describe("The ID of the notification to delete"),
    }),
    execute: async ({ notificationId }) => {
      const deleted = await deleteNotification(db, ctx, notificationId);
      return deleted ? { success: true } : { error: "Notification not found" };
    },
  });
  return {
    createNotification: create,
    listNotifications: list,
    updateNotification: update,
    deleteNotification: remove,
  };
}
