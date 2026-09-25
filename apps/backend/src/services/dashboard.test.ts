import { describe, it, expect, beforeEach } from "vitest";
import { mockLogger } from "../test-setup.ts";
import { resetMockDb, seedDb, type Row } from "../test-utils.ts";
import { db } from "../index.ts";
import { ConflictError, NotFoundError, ValidationError } from "../errors.ts";

import { getWidget, updateWidget } from "./dashboard.ts";

const workspaceId = "ws-1";
const dashboardId = "dash-1";
const widgetId = "widget-1";

const widget = (id: string, extra: Row = {}): Row => ({
  id,
  dashboardId,
  type: "metric",
  title: id,
  data: null,
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
  ...extra,
});

const world = (widgets: Row[] = [widget(widgetId)]) =>
  seedDb({
    dashboard: [
      { id: dashboardId, workspaceId, name: "Mine" },
      { id: "dash-other", workspaceId: "ws-2", name: "Theirs" },
    ],
    widget: [...widgets, widget("widget-other", { dashboardId: "dash-other" })],
  });

const find = (fake: ReturnType<typeof world>, id: string) =>
  fake.tables.widget.find((row) => row.id === id);

/**
 * The `type`/`data` pairing asserted against the shared update path itself,
 * not through a surface.
 *
 * The Agent tool set and the REST route both reach this function, and the
 * guarantee is that neither can write a payload belonging to another Widget
 * type. Pinning it here is what keeps the check in the one place both callers
 * pass through: move it up into a route or a tool and this fails, even while
 * that surface's own tests still pass.
 */
describe("updateWidget", () => {
  beforeEach(() => {
    resetMockDb();
  });

  const update = (
    data: unknown,
    extra: { type?: string; title?: string } = {},
    ids = { dashboardId, widgetId },
  ) =>
    updateWidget(db, ids.dashboardId, ids.widgetId, workspaceId, {
      type: (extra.type ?? "metric") as "metric",
      data,
      title: extra.title,
    });

  it("refuses a payload belonging to another widget type and writes nothing", async () => {
    const fake = world();

    // Thrown, not returned: the rule has two callers, so it cannot answer in
    // one caller's response shape (ADR-0010). The route lets `onError` map it
    // to 400 and the Tool adapter turns it into its `{ error }` result.
    await expect(update({ content: "hello" })).rejects.toThrow(ValidationError);
    expect(find(fake, widgetId)?.data).toBeNull();
  });

  it("writes the payload as the named type's own schema resolved it", async () => {
    const fake = world();

    await update({ value: 1, label: "Revenue", stowaway: true });

    expect(find(fake, widgetId)?.data).toEqual({ value: 1, label: "Revenue" });
  });

  it("reports a type that differs from the stored widget's without writing", async () => {
    const fake = world();

    await expect(update({ content: "hi" }, { type: "text" })).resolves.toEqual({
      typeMismatch: true,
    });
    expect(find(fake, widgetId)?.data).toBeNull();
  });

  it("renames the widget to a free title, and does not conflict with its own", async () => {
    const fake = world();

    await update({ value: 1, label: "x" }, { title: widgetId });
    expect(find(fake, widgetId)?.data).toEqual({ value: 1, label: "x" });
    await update({ value: 1, label: "x" }, { title: "Revenue" });

    expect(find(fake, widgetId)?.title).toBe("Revenue");
  });

  it("refuses a title another widget on the dashboard already has", async () => {
    const fake = world([widget(widgetId), widget("widget-2")]);

    await expect(
      update({ value: 1, label: "x" }, { title: "widget-2" }),
    ).rejects.toThrow(ConflictError);
    expect(find(fake, widgetId)?.title).toBe(widgetId);
  });

  it("allows a title only another dashboard's widget has", async () => {
    const fake = world();

    await update({ value: 1, label: "x" }, { title: "widget-other" });

    expect(find(fake, widgetId)?.title).toBe("widget-other");
  });

  it.each([
    ["a dashboard in another workspace", "dash-other", "widget-other"],
    ["another dashboard's widget", dashboardId, "widget-other"],
  ])("does not reach %s", async (_label, dash, id) => {
    const fake = world();

    await expect(
      update({ value: 1, label: "x" }, {}, { dashboardId: dash, widgetId: id }),
    ).rejects.toThrow(NotFoundError);
    expect(find(fake, "widget-other")?.data).toBeNull();
  });
});

describe("getWidget", () => {
  beforeEach(() => {
    resetMockDb();
  });

  it("returns a widget whose stored data matches its type", async () => {
    world([widget(widgetId, { data: { value: 1, label: "Revenue" } })]);

    await expect(
      getWidget(db, dashboardId, widgetId, workspaceId),
    ).resolves.toMatchObject({
      id: widgetId,
      type: "metric",
      data: { value: 1, label: "Revenue" },
    });
  });

  it("treats a widget whose stored data no longer parses as not found, and logs it", async () => {
    world([widget(widgetId, { data: { content: "wrong shape" } })]);

    await expect(
      getWidget(db, dashboardId, widgetId, workspaceId),
    ).rejects.toThrow(new NotFoundError("Widget not found"));
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ dashboardId, widgetId, widgetType: "metric" }),
      "Widget omitted from dashboard: stored data does not match its type",
    );
  });
});
