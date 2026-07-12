import { describe, it, expect, vi, beforeEach } from "vitest";
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
      const widgets = [{ id: widgetId, dashboardId, type: "metric" }];
      mockDb.orderBy.mockResolvedValueOnce(widgets);

      expect(await tools.listWidgets.execute!({ dashboardId }, ctx)).toEqual(
        widgets,
      );
    });
  });

  describe("updateWidgetData", () => {
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
