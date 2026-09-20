import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import {
  widgetTypeRegistry,
  type AgentWritableWidgetType,
} from "@platypus/schemas";
import { mockDb, resetMockDb } from "../test-utils.ts";

import { createDashboardTools } from "./dashboard.ts";

const ctx = { toolCallId: "test", messages: [], context: {} };

const agentWritableTypes = Object.entries(widgetTypeRegistry)
  .filter(([, definition]) => definition.agentWritable)
  .map(([type]) => type as AgentWritableWidgetType);

/**
 * One valid `data` payload per Agent-writable Widget type.
 *
 * `satisfies` the registry's Agent-writable subset, so a newly Agent-writable
 * type is a compile error here until it has a payload — the pairing tests
 * below then cover it on arrival instead of quietly skipping it.
 */
const validPayloads = {
  metric: { value: 100, label: "Revenue" },
  text: { content: "# Status\nAll good" },
  image: { url: "https://example.com/chart.png" },
  weather: {
    location: "Melbourne",
    date: "2026-01-01",
    condition: "rain",
    description: "Showers easing",
    temperatureC: 14,
    highC: 17,
    lowC: 9,
    unit: "C",
  },
  "line-chart": {
    categories: ["Jan", "Feb"],
    series: [{ label: "Revenue", values: [1, 2] }],
  },
  "pie-chart": { segments: [{ label: "Direct", value: 3 }] },
  "bar-chart": {
    categories: ["Jan", "Feb"],
    series: [{ label: "Revenue", values: [1, 2] }],
  },
} satisfies Record<AgentWritableWidgetType, unknown>;

/**
 * A payload belonging to a Widget type other than `type`.
 *
 * The Text payload is invalid for every other Agent-writable type, so it
 * serves as the mismatch for all of them; Text itself takes the Metric
 * payload. Pairing each type with its neighbour in the registry would not
 * work: Line Chart and Bar Chart declare structurally identical contracts, so
 * neither can detect the other's payload — correctly so, since data valid for
 * the named type is a legitimate write whatever else it also satisfies.
 */
const foreignPayload = (type: AgentWritableWidgetType) =>
  type === "text" ? validPayloads.metric : validPayloads.text;
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
    it("refuses a dashboard from another workspace", async () => {
      mockDb.limit.mockResolvedValueOnce([]);

      expect(await tools.listWidgets.execute!({ dashboardId }, ctx)).toEqual({
        error: "Dashboard not found",
      });
    });

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
    it("refuses a widget outside the requested dashboard", async () => {
      mockDb.limit.mockResolvedValueOnce([{ id: dashboardId, workspaceId }]);
      mockDb.limit.mockResolvedValueOnce([]);

      expect(
        await tools.getWidget.execute!({ dashboardId, widgetId }, ctx),
      ).toEqual({
        error: "Widget not found",
      });
    });

    it("returns embed widget data without exposing it to agent writes", async () => {
      mockDb.limit.mockResolvedValueOnce([{ id: dashboardId, workspaceId }]);
      const widget = {
        id: widgetId,
        dashboardId,
        title: "Status",
        type: "embed",
        data: { url: "https://status.example.com/embed" },
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
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

    // The hole this pair of tests closes: `type` and `data` are two
    // independent input fields, and `data` is an undiscriminated union, so the
    // input schema alone cannot tell that a payload belongs to another type.
    // The pairing is enforced in the shared update path, which is what these
    // exercise through the tool.
    it("refuses a payload belonging to another widget type, for every agent-writable type", async () => {
      for (const type of agentWritableTypes) {
        resetMockDb();
        vi.clearAllMocks();
        mockDb.limit.mockResolvedValueOnce([{ id: dashboardId, workspaceId }]);
        mockDb.limit.mockResolvedValueOnce([
          { id: widgetId, dashboardId, type },
        ]);

        const result = (await tools.updateWidgetData.execute!(
          { dashboardId, widgetId, type, data: foreignPayload(type) },
          ctx,
        )) as { error: string };

        expect(result.error, type).toContain(type);
        expect(mockDb.update, type).not.toHaveBeenCalled();
      }
    });

    it("names the widget type and the failing field, without echoing the input", async () => {
      mockDb.limit.mockResolvedValueOnce([{ id: dashboardId, workspaceId }]);
      mockDb.limit.mockResolvedValueOnce([
        { id: widgetId, dashboardId, type: "metric" },
      ]);

      const result = (await tools.updateWidgetData.execute!(
        { dashboardId, widgetId, type: "metric", data: { content: "hello" } },
        ctx,
      )) as { error: string };

      expect(result.error).toContain("metric");
      expect(result.error).toContain("data.value");
      // The model gets the failing paths, not its own payload read back (#406).
      expect(result.error).not.toContain("hello");
    });

    it("accepts the matching payload for every agent-writable widget type", async () => {
      for (const type of agentWritableTypes) {
        resetMockDb();
        vi.clearAllMocks();
        mockDb.limit.mockResolvedValueOnce([{ id: dashboardId, workspaceId }]);
        mockDb.limit.mockResolvedValueOnce([
          { id: widgetId, dashboardId, type },
        ]);
        const updated = {
          id: widgetId,
          dashboardId,
          type,
          data: validPayloads[type],
        };
        mockDb.returning.mockResolvedValueOnce([updated]);

        expect(
          await tools.updateWidgetData.execute!(
            { dashboardId, widgetId, type, data: validPayloads[type] },
            ctx,
          ),
          type,
        ).toEqual(updated);
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
