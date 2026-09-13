import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  mockDb,
  mockSession,
  mockNoSession,
  resetMockDb,
} from "../test-utils.ts";
import app from "../server.ts";
import { logger } from "../logger.ts";
import type { WidgetType } from "@platypus/schemas";

vi.mock("nanoid", () => ({
  nanoid: vi.fn(() => "test-id-123"),
}));

describe("Dashboard Routes", () => {
  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
    mockDb.where.mockReturnValue(mockDb);
  });

  const orgId = "org-1";
  const workspaceId = "ws-1";
  const dashboardId = "dash-1";
  const widgetId = "widget-1";
  const baseUrl = `/organizations/${orgId}/workspaces/${workspaceId}/dashboards`;

  const createdAt = new Date("2026-01-01T00:00:00.000Z");

  /**
   * A Widget row as the read path receives it from the database.
   *
   * `data` is deliberately `unknown` rather than the payload for `type`: these
   * fixtures need to express the mismatched rows the parse is there to reject.
   * Every other key is checked, so a typo cannot quietly produce an invalid row
   * that a drop test then "proves" is dropped.
   */
  type WidgetRowFixture = {
    type: WidgetType;
    id?: string;
    dashboardId?: string;
    title?: string;
    data?: unknown;
    createdAt?: Date;
    updatedAt?: Date;
  };

  const widgetRow = (overrides: WidgetRowFixture) => ({
    id: widgetId,
    dashboardId,
    title: "A widget",
    data: null,
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  });

  /** The same row as it appears once serialized to JSON. */
  const serialized = (row: ReturnType<typeof widgetRow>) => ({
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });

  /** The org, workspace and dashboard lookups the widget list performs first. */
  const mockWidgetListAuth = () => {
    mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
    mockDb.limit.mockResolvedValueOnce([
      { ownerId: "user-1", organizationId: "org-1" },
    ]);
    mockDb.limit.mockResolvedValueOnce([{ id: dashboardId, workspaceId }]);
  };

  // --- Dashboard CRUD ---

  describe("GET /", () => {
    it("returns 401 if not authenticated", async () => {
      mockNoSession();
      const res = await app.request(baseUrl);
      expect(res.status).toBe(401);
    });

    it("lists all dashboards in workspace", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]); // requireWorkspaceAccess
      const mockDashboards = [{ id: dashboardId, name: "Dash 1", workspaceId }];
      mockDb.orderBy.mockResolvedValueOnce(mockDashboards);

      const res = await app.request(baseUrl);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ results: mockDashboards });
    });
  });

  describe("POST /", () => {
    it("returns 401 if not authenticated", async () => {
      mockNoSession();
      const res = await app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify({ name: "New Dashboard" }),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(401);
    });

    it("creates a dashboard", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]);
      const mockDash = {
        id: "test-id-123",
        name: "New Dashboard",
        workspaceId,
        desktopLayout: [],
        mobileLayout: [],
      };
      mockDb.returning.mockResolvedValueOnce([mockDash]);

      const res = await app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify({ name: "New Dashboard" }),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(201);
      expect(await res.json()).toEqual(mockDash);
    });

    it("returns 400 if name is missing", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]);

      const res = await app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify({}),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(400);
    });
  });

  describe("GET /:dashboardId", () => {
    it("returns 401 if not authenticated", async () => {
      mockNoSession();
      const res = await app.request(`${baseUrl}/${dashboardId}`);
      expect(res.status).toBe(401);
    });

    it("returns 404 if dashboard not found", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]);
      mockDb.limit.mockResolvedValueOnce([]);

      const res = await app.request(`${baseUrl}/${dashboardId}`);
      expect(res.status).toBe(404);
    });

    it("returns dashboard", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]);
      const mockDash = { id: dashboardId, workspaceId, name: "Dash 1" };
      mockDb.limit.mockResolvedValueOnce([mockDash]);

      const res = await app.request(`${baseUrl}/${dashboardId}`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(mockDash);
    });
  });

  describe("PUT /:dashboardId", () => {
    it("returns 404 if dashboard not found", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]);
      mockDb.limit.mockResolvedValueOnce([]);

      const res = await app.request(`${baseUrl}/${dashboardId}`, {
        method: "PUT",
        body: JSON.stringify({ name: "Updated" }),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(404);
    });

    it("updates dashboard", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]);
      mockDb.limit.mockResolvedValueOnce([{ id: dashboardId, workspaceId }]);
      const updated = { id: dashboardId, name: "Updated", workspaceId };
      mockDb.returning.mockResolvedValueOnce([updated]);

      const res = await app.request(`${baseUrl}/${dashboardId}`, {
        method: "PUT",
        body: JSON.stringify({ name: "Updated" }),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(updated);
    });
  });

  describe("DELETE /:dashboardId", () => {
    it("returns 404 if dashboard not found", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]);
      mockDb.limit.mockResolvedValueOnce([]);

      const res = await app.request(`${baseUrl}/${dashboardId}`, {
        method: "DELETE",
      });
      expect(res.status).toBe(404);
    });

    it("deletes dashboard and returns 204", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]);
      mockDb.limit.mockResolvedValueOnce([{ id: dashboardId, workspaceId }]);

      const res = await app.request(`${baseUrl}/${dashboardId}`, {
        method: "DELETE",
      });
      expect(res.status).toBe(204);
    });
  });

  // --- Widget CRUD ---

  describe("GET /:dashboardId/widgets", () => {
    it("returns 401 if not authenticated", async () => {
      mockNoSession();
      const res = await app.request(`${baseUrl}/${dashboardId}/widgets`);
      expect(res.status).toBe(401);
    });

    it("returns 404 if dashboard not found", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]);
      mockDb.limit.mockResolvedValueOnce([]);

      const res = await app.request(`${baseUrl}/${dashboardId}/widgets`);
      expect(res.status).toBe(404);
    });

    it("lists widgets on a dashboard", async () => {
      mockSession();
      mockWidgetListAuth();
      const metric = widgetRow({
        type: "metric",
        data: { value: 42, label: "Signups" },
      });
      mockDb.orderBy.mockResolvedValueOnce([metric]);

      const res = await app.request(`${baseUrl}/${dashboardId}/widgets`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ results: [serialized(metric)] });
    });

    it("returns a widget whose data is null", async () => {
      mockSession();
      mockWidgetListAuth();
      // A freshly created Widget has no data until it is first edited, so a
      // null payload is the normal case and must survive the read parse.
      const fresh = widgetRow({ type: "embed", data: null });
      mockDb.orderBy.mockResolvedValueOnce([fresh]);

      const res = await app.request(`${baseUrl}/${dashboardId}/widgets`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ results: [serialized(fresh)] });
    });

    it("drops an embed widget whose stored URL is not https", async () => {
      mockSession();
      mockWidgetListAuth();
      const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
      const tampered = widgetRow({
        id: "widget-http",
        type: "embed",
        data: { url: "http://insecure.example.com/embed" },
      });
      mockDb.orderBy.mockResolvedValueOnce([tampered]);

      const res = await app.request(`${baseUrl}/${dashboardId}/widgets`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ results: [] });
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ dashboardId, widgetId: "widget-http" }),
        expect.any(String),
      );
    });

    it("keeps the rest of the dashboard when one widget fails to parse", async () => {
      mockSession();
      mockWidgetListAuth();
      vi.spyOn(logger, "warn").mockImplementation(() => {});
      const good = widgetRow({
        id: "widget-good",
        type: "text",
        data: { content: "Still here" },
      });
      // A metric payload stored against a text Widget — the cross-type
      // mismatch a plain data union used to let through.
      const mismatched = widgetRow({
        id: "widget-bad",
        type: "text",
        data: { value: 1, label: "Wrong shape" },
      });
      mockDb.orderBy.mockResolvedValueOnce([good, mismatched]);

      const res = await app.request(`${baseUrl}/${dashboardId}/widgets`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ results: [serialized(good)] });
    });
  });

  describe("POST /:dashboardId/widgets", () => {
    it("returns 404 if dashboard not found", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]);
      mockDb.limit.mockResolvedValueOnce([]);

      const res = await app.request(`${baseUrl}/${dashboardId}/widgets`, {
        method: "POST",
        body: JSON.stringify({ type: "metric", title: "Revenue" }),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(404);
    });

    it("creates a widget", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]);
      mockDb.limit.mockResolvedValueOnce([{ id: dashboardId, workspaceId }]);
      const mockWidget = {
        id: "test-id-123",
        dashboardId,
        type: "metric",
        title: "Revenue",
        data: null,
      };
      mockDb.returning.mockResolvedValueOnce([mockWidget]);

      const res = await app.request(`${baseUrl}/${dashboardId}/widgets`, {
        method: "POST",
        body: JSON.stringify({ type: "metric", title: "Revenue" }),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(201);
      expect(await res.json()).toEqual(mockWidget);
    });

    it("returns 400 for invalid widget type", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]);

      const res = await app.request(`${baseUrl}/${dashboardId}/widgets`, {
        method: "POST",
        body: JSON.stringify({ type: "chart", title: "Revenue" }),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(400);
    });
  });

  describe("PUT /:dashboardId/widgets/:widgetId", () => {
    it("returns 404 if widget not found", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]);
      mockDb.limit.mockResolvedValueOnce([{ id: dashboardId, workspaceId }]);
      mockDb.limit.mockResolvedValueOnce([]);

      const res = await app.request(
        `${baseUrl}/${dashboardId}/widgets/${widgetId}`,
        {
          method: "PUT",
          body: JSON.stringify({
            type: "metric",
            data: { value: 42, label: "Sales" },
          }),
          headers: { "Content-Type": "application/json" },
        },
      );
      expect(res.status).toBe(404);
    });

    it("returns 400 on widget type mismatch", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]);
      mockDb.limit.mockResolvedValueOnce([{ id: dashboardId, workspaceId }]);
      mockDb.limit.mockResolvedValueOnce([
        { id: widgetId, dashboardId, type: "text" },
      ]);

      const res = await app.request(
        `${baseUrl}/${dashboardId}/widgets/${widgetId}`,
        {
          method: "PUT",
          body: JSON.stringify({
            type: "metric",
            data: { value: 42, label: "Sales" },
          }),
          headers: { "Content-Type": "application/json" },
        },
      );
      expect(res.status).toBe(400);
    });

    it("updates widget data", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]);
      mockDb.limit.mockResolvedValueOnce([{ id: dashboardId, workspaceId }]);
      mockDb.limit.mockResolvedValueOnce([
        { id: widgetId, dashboardId, type: "metric" },
      ]);
      const updated = {
        id: widgetId,
        dashboardId,
        type: "metric",
        data: { value: 42, label: "Sales" },
      };
      mockDb.returning.mockResolvedValueOnce([updated]);

      const res = await app.request(
        `${baseUrl}/${dashboardId}/widgets/${widgetId}`,
        {
          method: "PUT",
          body: JSON.stringify({
            type: "metric",
            data: { value: 42, label: "Sales" },
          }),
          headers: { "Content-Type": "application/json" },
        },
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(updated);
    });
  });

  describe("DELETE /:dashboardId/widgets/:widgetId", () => {
    it("returns 404 if widget not found", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]);
      mockDb.limit.mockResolvedValueOnce([{ id: dashboardId, workspaceId }]);
      mockDb.limit.mockResolvedValueOnce([]);

      const res = await app.request(
        `${baseUrl}/${dashboardId}/widgets/${widgetId}`,
        { method: "DELETE" },
      );
      expect(res.status).toBe(404);
    });

    it("deletes widget and returns 204", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]);
      mockDb.limit.mockResolvedValueOnce([{ id: dashboardId, workspaceId }]);
      mockDb.limit.mockResolvedValueOnce([{ id: widgetId, dashboardId }]);

      const res = await app.request(
        `${baseUrl}/${dashboardId}/widgets/${widgetId}`,
        { method: "DELETE" },
      );
      expect(res.status).toBe(204);
    });
  });
});
