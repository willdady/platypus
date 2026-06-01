import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  mockDb,
  mockSession,
  mockNoSession,
  resetMockDb,
} from "../test-utils.ts";
import app from "../server.ts";

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
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]);
      mockDb.limit.mockResolvedValueOnce([{ id: dashboardId, workspaceId }]);
      const mockWidgets = [{ id: widgetId, dashboardId, type: "metric" }];
      mockDb.orderBy.mockResolvedValueOnce(mockWidgets);

      const res = await app.request(`${baseUrl}/${dashboardId}/widgets`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ results: mockWidgets });
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
