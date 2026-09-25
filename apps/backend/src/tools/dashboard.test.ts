import { describe, it, expect, beforeEach } from "vitest";
import { z } from "zod";
import {
  widgetTypeRegistry,
  type AgentWritableWidgetType,
} from "@platypus/schemas";
import { callTool, resetMockDb, seedDb, type FakeDb } from "../test-utils.ts";

import { createDashboardTools } from "./dashboard.ts";

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

const dashboard = (id: string, ws: string, createdAt: string) => ({
  id,
  workspaceId: ws,
  name: id,
  createdAt: new Date(createdAt),
});

const widget = (
  id: string,
  type: string,
  data: unknown,
  over: Record<string, unknown> = {},
) => ({
  id,
  dashboardId,
  type,
  title: id,
  data,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  ...over,
});

describe("createDashboardTools", () => {
  let tools: ReturnType<typeof createDashboardTools>;
  let db: FakeDb;

  /** Seeds this workspace's dashboard holding one widget of `type`. */
  const seedWidget = (type: string, data: unknown = {}) => {
    db = seedDb({
      dashboard: [dashboard(dashboardId, workspaceId, "2026-01-01")],
      widget: [widget(widgetId, type, data)],
    });
  };

  const update = (type: AgentWritableWidgetType, data: unknown) =>
    callTool(tools.updateWidgetData, {
      dashboardId,
      widgetId,
      type,
      data: data as never,
    });

  beforeEach(() => {
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

  it("listDashboards returns this workspace's dashboards, oldest first", async () => {
    seedDb({
      dashboard: [
        dashboard("newer", workspaceId, "2026-02-01"),
        dashboard("theirs", "ws-2", "2026-01-15"),
        dashboard("older", workspaceId, "2026-01-01"),
      ],
    });

    expect(await callTool(tools.listDashboards, {})).toMatchObject([
      { id: "older" },
      { id: "newer" },
    ]);
  });

  describe("listWidgets", () => {
    it("lists this dashboard's widgets as id, type and title only", async () => {
      seedDb({
        dashboard: [dashboard(dashboardId, workspaceId, "2026-01-01")],
        widget: [
          widget("w1", "metric", validPayloads.metric),
          widget("w-other", "text", validPayloads.text, {
            dashboardId: "dash-2",
          }),
        ],
      });

      expect(await callTool(tools.listWidgets, { dashboardId })).toEqual([
        { id: "w1", type: "metric", title: "w1" },
      ]);
    });

    it("refuses a dashboard from another workspace", async () => {
      seedDb({
        dashboard: [dashboard(dashboardId, "ws-2", "2026-01-01")],
        widget: [widget(widgetId, "metric", validPayloads.metric)],
      });

      expect(await callTool(tools.listWidgets, { dashboardId })).toEqual({
        error: "Dashboard not found",
      });
    });
  });

  describe("getWidget", () => {
    it("returns an embed widget's data, though agents cannot write it", async () => {
      seedWidget("embed", { url: "https://status.example.com/embed" });

      expect(
        await callTool(tools.getWidget, { dashboardId, widgetId }),
      ).toEqual(
        widget(widgetId, "embed", { url: "https://status.example.com/embed" }),
      );
    });

    it("refuses a widget on another dashboard", async () => {
      seedWidget("metric", validPayloads.metric);

      expect(
        await callTool(tools.getWidget, { dashboardId, widgetId: "missing" }),
      ).toEqual({ error: "Widget not found" });
    });

    it("refuses a dashboard from another workspace", async () => {
      seedDb({
        dashboard: [dashboard(dashboardId, "ws-2", "2026-01-01")],
        widget: [widget(widgetId, "metric", validPayloads.metric)],
      });

      expect(
        await callTool(tools.getWidget, { dashboardId, widgetId }),
      ).toEqual({ error: "Dashboard not found" });
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

    it.each(agentWritableTypes)(
      "stores the matching payload for a %s widget",
      async (type) => {
        seedWidget(type);

        expect(await update(type, validPayloads[type])).toMatchObject({
          id: widgetId,
          type,
          data: validPayloads[type],
        });
        expect(db.tables.widget[0].data).toEqual(validPayloads[type]);
      },
    );

    // The hole this closes: `type` and `data` are two independent input
    // fields, and `data` is an undiscriminated union, so the input schema
    // alone cannot tell that a payload belongs to another type. The pairing
    // is enforced in the shared update path, exercised here through the tool.
    it.each(agentWritableTypes)(
      "refuses another type's payload for a %s widget",
      async (type) => {
        seedWidget(type);

        const result: unknown = await update(type, foreignPayload(type));

        expect(result).toEqual({
          error: expect.stringContaining(`"${type}"`) as unknown,
        });
        expect(db.tables.widget[0].data).toEqual({});
      },
    );

    it("names the widget type and the failing field, without echoing the input", async () => {
      seedWidget("metric");

      const result = (await update("metric", { content: "hello" })) as {
        error: string;
      };

      expect(result.error).toContain("metric");
      expect(result.error).toContain("data.value");
      // The model gets the failing paths, not its own payload read back (#406).
      expect(result.error).not.toContain("hello");
    });

    it("refuses when the stored widget is a different type", async () => {
      seedWidget("text", validPayloads.text);

      expect(await update("metric", validPayloads.metric)).toEqual({
        error: "Widget type mismatch",
      });
      expect(db.tables.widget[0].data).toEqual(validPayloads.text);
    });

    it("refuses a widget on another dashboard", async () => {
      seedWidget("metric");
      db.tables.widget[0].dashboardId = "dash-2";

      expect(await update("metric", validPayloads.metric)).toEqual({
        error: "Widget not found",
      });
    });

    it("refuses a dashboard from another workspace", async () => {
      seedWidget("metric");
      db.tables.dashboard[0].workspaceId = "ws-2";

      expect(await update("metric", validPayloads.metric)).toEqual({
        error: "Dashboard not found",
      });
      expect(db.tables.widget[0].data).toEqual({});
    });
  });
});
