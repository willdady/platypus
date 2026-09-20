import { tool, type Tool } from "ai";
import { z } from "zod";
import {
  agentWritableWidgetDataSchema,
  agentWritableWidgetTypeSchema,
} from "@platypus/schemas";
import { db } from "../index.ts";
import { ConflictError, NotFoundError, ValidationError } from "../errors.ts";
import {
  getWidget,
  listDashboards as listDashboardsService,
  listWidgets as listWidgetsService,
  updateWidget,
} from "../services/dashboard.ts";

export function createDashboardTools(
  workspaceId: string,
): Record<string, Tool> {
  async function asToolResult<T>(
    run: () => Promise<T>,
  ): Promise<T | { error: string }> {
    try {
      return await run();
    } catch (error) {
      if (
        error instanceof NotFoundError ||
        error instanceof ConflictError ||
        error instanceof ValidationError
      )
        return { error: error.message };
      throw error;
    }
  }

  const listDashboards = tool({
    description: "List all dashboards in this workspace",
    inputSchema: z.object({}),
    execute: async () => listDashboardsService(db, workspaceId),
  });
  const listWidgets = tool({
    description:
      "List all widgets on a dashboard (id, type, title only — use getWidget for full data)",
    inputSchema: z.object({
      dashboardId: z.string().describe("The ID of the dashboard"),
    }),
    execute: async ({ dashboardId }) =>
      asToolResult(async () =>
        listWidgetsService(db, dashboardId, workspaceId),
      ),
  });
  const getWidgetTool = tool({
    description: "Get a single widget by ID including its full data",
    inputSchema: z.object({
      dashboardId: z.string().describe("The ID of the dashboard"),
      widgetId: z.string().describe("The ID of the widget"),
    }),
    execute: async ({ dashboardId, widgetId }) =>
      asToolResult(async () =>
        getWidget(db, dashboardId, widgetId, workspaceId),
      ),
  });
  const updateWidgetData = tool({
    description:
      "Update the data of a widget by ID. You must provide the widget's type — if it doesn't match the stored type the update is rejected.",
    inputSchema: z.object({
      dashboardId: z.string().describe("The ID of the dashboard"),
      widgetId: z.string().describe("The ID of the widget to update"),
      type: agentWritableWidgetTypeSchema.describe(
        "The widget type — must match the widget's existing type",
      ),
      data: agentWritableWidgetDataSchema.describe(
        "The new data for the widget — must match the widget's type",
      ),
    }),
    execute: async ({ dashboardId, widgetId, type, data }) =>
      asToolResult(async () => {
        const result = await updateWidget(
          db,
          dashboardId,
          widgetId,
          workspaceId,
          { type, data },
        );
        if (result && "typeMismatch" in result)
          return { error: "Widget type mismatch" };
        if (!result) return { error: "Widget not found" };
        return result;
      }),
  });
  return {
    listDashboards,
    listWidgets,
    getWidget: getWidgetTool,
    updateWidgetData,
  };
}
