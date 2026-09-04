import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import { widgetTypeRegistry } from "@platypus/schemas";
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
        { id: "widget-embed", dashboardId, type: "embed" },
      ];
      mockDb.orderBy.mockResolvedValueOnce(widgets);

      expect(await tools.listWidgets.execute!({ dashboardId }, ctx)).toEqual(
        widgets,
      );
    });
  });

  describe("getWidget", () => {
    it("returns embed widget data without exposing it to agent writes", async () => {
      mockDb.limit.mockResolvedValueOnce([{ id: dashboardId, workspaceId }]);
      const widget = {
        id: widgetId,
        dashboardId,
        type: "embed",
        data: { url: "https://status.example.com/embed" },
      };
      mockDb.limit.mockResolvedValueOnce([widget]);

      expect(
        await tools.getWidget.execute!({ dashboardId, widgetId }, ctx),
      ).toEqual(widget);
    });
  });

  describe("updateWidgetData", () => {
    // The invariant, not one type: whatever the registry declares
    // non-writable, the tool must refuse. A new widget type that declares
    // `agentWritable: false` is covered the moment it is added.
    it("accepts exactly the widget types the registry marks agent-writable", () => {
      const schema = tools.updateWidgetData
        .inputSchema as unknown as z.ZodObject<{
        type: z.ZodEnum<Record<string, string>>;
      }>;
      const accepted = schema.shape.type.options;

      expect(Object.keys(widgetTypeRegistry).length).toBeGreaterThan(
        accepted.length,
      );
      for (const [type, definition] of Object.entries(widgetTypeRegistry)) {
        expect(accepted.includes(type), type).toBe(definition.agentWritable);
      }
    });

    it("rejects every widget type the registry marks human-owned", () => {
      const schema = tools.updateWidgetData.inputSchema as z.ZodType;
      const humanOwned = Object.entries(widgetTypeRegistry).filter(
        ([, definition]) => !definition.agentWritable,
      );

      expect(humanOwned.length).toBeGreaterThan(0);
      for (const [type] of humanOwned) {
        const result = schema.safeParse({
          dashboardId,
          widgetId,
          type,
          data: { url: "https://status.example.com/embed" },
        });

        expect(result.success, type).toBe(false);
        // Rejected for the type itself, not incidentally for the data shape.
        expect(
          result.error?.issues.some((issue) => issue.path[0] === "type"),
          type,
        ).toBe(true);
      }
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
