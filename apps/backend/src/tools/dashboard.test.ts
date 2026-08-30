import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import { mockDb, resetMockDb } from "../test-utils.ts";

import { createDashboardTools } from "./dashboard.ts";

const ctx = { toolCallId: "test", messages: [], context: {} };
const workspaceId = "ws-1";
const dashboardId = "dash-1";
const widgetId = "widget-1";

describe("createDashboardTools", () => {
  let tools: ReturnType<typeof createDashboardTools>;

  beforeEach(() => {
    vi.clearAllMocks();
    resetMockDb();
    tools = createDashboardTools(workspaceId);
  });

  it("returns the expected tool names", () => {
    expect(Object.keys(tools)).toEqual([
      "listDashboards",
      "listWidgets",
      "getWidget",
      "updateWidgetData",
    ]);
  });

  describe("listDashboards", () => {
    it("returns dashboards in workspace", async () => {
      const dashboards = [{ id: dashboardId, name: "Sales" }];
      mockDb.orderBy.mockResolvedValueOnce(dashboards);

      expect(await tools.listDashboards.execute!({}, ctx)).toEqual(dashboards);
    });
  });

  describe("listWidgets", () => {
    it("returns error when dashboard not found", async () => {
      mockDb.limit.mockResolvedValueOnce([]);

      expect(await tools.listWidgets.execute!({ dashboardId }, ctx)).toEqual({
        error: "Dashboard not found",
      });
    });

    it("returns widgets for a dashboard", async () => {
      mockDb.limit.mockResolvedValueOnce([{ id: dashboardId, workspaceId }]);
      const widgets = [
        { id: widgetId, dashboardId, type: "metric" },
        { id: "widget-iframe", dashboardId, type: "iframe" },
      ];
      mockDb.orderBy.mockResolvedValueOnce(widgets);

      expect(await tools.listWidgets.execute!({ dashboardId }, ctx)).toEqual(
        widgets,
      );
    });
  });

  describe("getWidget", () => {
    it("returns iframe widget data without exposing it to agent writes", async () => {
      mockDb.limit.mockResolvedValueOnce([{ id: dashboardId, workspaceId }]);
      const widget = {
        id: widgetId,
        dashboardId,
        type: "iframe",
        data: { url: "https://status.example.com/embed" },
      };
      mockDb.limit.mockResolvedValueOnce([widget]);

      expect(
        await tools.getWidget.execute!({ dashboardId, widgetId }, ctx),
      ).toEqual(widget);
    });
  });

  describe("updateWidgetData", () => {
    it("does not expose iframe as an agent-writable widget type", () => {
      const schema = tools.updateWidgetData.inputSchema as z.ZodType;

      expect(
        schema.safeParse({
          dashboardId,
          widgetId,
          type: "iframe",
          data: { url: "https://status.example.com/embed" },
        }).success,
      ).toBe(false);
    });

    it("returns error when dashboard not found", async () => {
      mockDb.limit.mockResolvedValueOnce([]);

      expect(
        await tools.updateWidgetData.execute!(
          {
            dashboardId,
            widgetId,
            type: "metric",
            data: { value: 100, label: "Revenue" },
          },
          ctx,
        ),
      ).toEqual({ error: "Dashboard not found" });
    });

    it("returns error when widget not found", async () => {
      mockDb.limit.mockResolvedValueOnce([{ id: dashboardId, workspaceId }]);
      mockDb.limit.mockResolvedValueOnce([]);

      expect(
        await tools.updateWidgetData.execute!(
          {
            dashboardId,
            widgetId,
            type: "metric",
            data: { value: 100, label: "Revenue" },
          },
          ctx,
        ),
      ).toEqual({ error: "Widget not found" });
    });

    it("returns error on widget type mismatch", async () => {
      mockDb.limit.mockResolvedValueOnce([{ id: dashboardId, workspaceId }]);
      mockDb.limit.mockResolvedValueOnce([
        { id: widgetId, dashboardId, type: "text" },
      ]);

      expect(
        await tools.updateWidgetData.execute!(
          {
            dashboardId,
            widgetId,
            type: "metric",
            data: { value: 100, label: "Revenue" },
          },
          ctx,
        ),
      ).toEqual({ error: "Widget type mismatch" });
    });

    it("updates metric widget data", async () => {
      mockDb.limit.mockResolvedValueOnce([{ id: dashboardId, workspaceId }]);
      mockDb.limit.mockResolvedValueOnce([
        { id: widgetId, dashboardId, type: "metric" },
      ]);
      const updated = {
        id: widgetId,
        dashboardId,
        type: "metric",
        data: { value: 100, label: "Revenue" },
      };
      mockDb.returning.mockResolvedValueOnce([updated]);

      expect(
        await tools.updateWidgetData.execute!(
          {
            dashboardId,
            widgetId,
            type: "metric",
            data: { value: 100, label: "Revenue" },
          },
          ctx,
        ),
      ).toEqual(updated);
    });

    it("updates text widget data", async () => {
      mockDb.limit.mockResolvedValueOnce([{ id: dashboardId, workspaceId }]);
      mockDb.limit.mockResolvedValueOnce([
        { id: widgetId, dashboardId, type: "text" },
      ]);
      const updated = {
        id: widgetId,
        dashboardId,
        type: "text",
        data: { content: "# Status\nAll good" },
      };
      mockDb.returning.mockResolvedValueOnce([updated]);

      expect(
        await tools.updateWidgetData.execute!(
          {
            dashboardId,
            widgetId,
            type: "text",
            data: { content: "# Status\nAll good" },
          },
          ctx,
        ),
      ).toEqual(updated);
    });
  });
});
