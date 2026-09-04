import { tool, type Tool } from "ai";
import { z } from "zod";
import { asc, eq } from "drizzle-orm";
import { db } from "../index.ts";
import {
  dashboard as dashboardTable,
  widget as widgetTable,
} from "../db/schema.ts";
import {
  agentWritableWidgetDataSchema,
  agentWritableWidgetTypeSchema,
} from "@platypus/schemas";

export function createDashboardTools(
  workspaceId: string,
): Record<string, Tool> {
  const listDashboards = tool({
    description: "List all dashboards in this workspace",
    inputSchema: z.object({}),
    execute: async () => {
      return await db
        .select({
          id: dashboardTable.id,
          workspaceId: dashboardTable.workspaceId,
          name: dashboardTable.name,
          description: dashboardTable.description,
          createdAt: dashboardTable.createdAt,
          updatedAt: dashboardTable.updatedAt,
        })
        .from(dashboardTable)
        .where(eq(dashboardTable.workspaceId, workspaceId))
        .orderBy(asc(dashboardTable.createdAt));
    },
  });

  const listWidgets = tool({
    description:
      "List all widgets on a dashboard (id, type, title only — use getWidget for full data)",
    inputSchema: z.object({
      dashboardId: z.string().describe("The ID of the dashboard"),
    }),
    execute: async ({ dashboardId }) => {
      const dash = await db
        .select({
          id: dashboardTable.id,
          workspaceId: dashboardTable.workspaceId,
        })
        .from(dashboardTable)
        .where(eq(dashboardTable.id, dashboardId))
        .limit(1);
      if (!dash.length || dash[0].workspaceId !== workspaceId) {
        return { error: "Dashboard not found" };
      }
      return await db
        .select({
          id: widgetTable.id,
          type: widgetTable.type,
          title: widgetTable.title,
        })
        .from(widgetTable)
        .where(eq(widgetTable.dashboardId, dashboardId))
        .orderBy(asc(widgetTable.createdAt));
    },
  });

  const getWidget = tool({
    description: "Get a single widget by ID including its full data",
    inputSchema: z.object({
      dashboardId: z.string().describe("The ID of the dashboard"),
      widgetId: z.string().describe("The ID of the widget"),
    }),
    execute: async ({ dashboardId, widgetId }) => {
      const dash = await db
        .select({
          id: dashboardTable.id,
          workspaceId: dashboardTable.workspaceId,
        })
        .from(dashboardTable)
        .where(eq(dashboardTable.id, dashboardId))
        .limit(1);
      if (!dash.length || dash[0].workspaceId !== workspaceId) {
        return { error: "Dashboard not found" };
      }
      const result = await db
        .select()
        .from(widgetTable)
        .where(eq(widgetTable.id, widgetId))
        .limit(1);
      if (!result.length || result[0].dashboardId !== dashboardId) {
        return { error: "Widget not found" };
      }
      return result[0];
    },
  });

  const updateWidgetData = tool({
    description:
      "Update the data of a widget by ID. You must provide the widget's type — if it doesn't match the stored type the update is rejected.",
    inputSchema: z.object({
      dashboardId: z.string().describe("The ID of the dashboard"),
      widgetId: z.string().describe("The ID of the widget to update"),
      // Both derived from the widget type registry's `agentWritable` entries,
      // never listed here: a type an Agent must not write (Embed) is excluded
      // because the registry says so, not because this list forgot it.
      type: agentWritableWidgetTypeSchema.describe(
        "The widget type — must match the widget's existing type",
      ),
      data: agentWritableWidgetDataSchema.describe(
        "The new data for the widget — must match the widget's type",
      ),
    }),
    execute: async ({ dashboardId, widgetId, type, data }) => {
      const dash = await db
        .select({
          id: dashboardTable.id,
          workspaceId: dashboardTable.workspaceId,
        })
        .from(dashboardTable)
        .where(eq(dashboardTable.id, dashboardId))
        .limit(1);
      if (!dash.length || dash[0].workspaceId !== workspaceId) {
        return { error: "Dashboard not found" };
      }
      const existing = await db
        .select({
          id: widgetTable.id,
          dashboardId: widgetTable.dashboardId,
          type: widgetTable.type,
        })
        .from(widgetTable)
        .where(eq(widgetTable.id, widgetId))
        .limit(1);
      if (!existing.length || existing[0].dashboardId !== dashboardId) {
        return { error: "Widget not found" };
      }
      if (existing[0].type !== type) {
        return { error: "Widget type mismatch" };
      }
      const updated = await db
        .update(widgetTable)
        .set({ data, updatedAt: new Date() })
        .where(eq(widgetTable.id, widgetId))
        .returning();
      return updated[0];
    },
  });

  return { listDashboards, listWidgets, getWidget, updateWidgetData };
}
