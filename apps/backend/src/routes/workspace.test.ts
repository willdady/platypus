import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  mockDb,
  mockSession,
  mockNoSession,
  resetMockDb,
} from "../test-utils.ts";
import app from "../server.ts";

describe("Workspace Routes", () => {
  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();

    // Force reset where to ensure it returns mockDb
    mockDb.where.mockReturnValue(mockDb);
  });

  describe("POST /organizations/:orgId/workspaces", () => {
    it("should create workspace for any org member", async () => {
      mockSession({ id: "user-1", role: "user" });

      // Mock requireOrgAccess: return member role
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);

      // Mock insert
      const mockWorkspace = { id: "ws-1", name: "New Workspace" };
      mockDb.returning.mockResolvedValueOnce([mockWorkspace]);

      const res = await app.request("/organizations/org-1/workspaces", {
        method: "POST",
        body: JSON.stringify({
          name: "New Workspace",
          organizationId: "org-1",
        }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(201);
      expect(await res.json()).toEqual(mockWorkspace);
    });
  });

  describe("GET /organizations/:orgId/workspaces", () => {
    it("should return all workspaces for org admin", async () => {
      mockSession({ id: "user-1", role: "user" });
      const mockWorkspaces = [{ id: "ws-1", name: "WS 1" }];

      // Mock requireOrgAccess: return admin role
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]);

      // Mock list workspaces
      mockDb.where
        .mockReturnValueOnce(mockDb)
        .mockResolvedValueOnce(mockWorkspaces);

      const res = await app.request("/organizations/org-1/workspaces");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ results: mockWorkspaces });
    });

    it("should return only owned workspaces for regular member", async () => {
      mockSession({ id: "user-1", role: "user" });
      const mockWorkspaces = [{ id: "ws-1", name: "WS 1" }];

      // Mock requireOrgAccess: return member role
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);

      // Mock get owned workspaces (single query with and(orgId, ownerId))
      mockDb.where
        .mockReturnValueOnce(mockDb) // requireOrgAccess
        .mockResolvedValueOnce(mockWorkspaces); // owned workspaces

      const res = await app.request("/organizations/org-1/workspaces");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ results: mockWorkspaces });
    });
  });

  describe("GET /organizations/:orgId/workspaces/:workspaceId", () => {
    it("should return workspace", async () => {
      mockSession({ id: "user-1", role: "user" });
      const mockWorkspace = { id: "ws-1", name: "WS 1" };

      // Mock requireOrgAccess: return member role
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
      // Mock requireWorkspaceAccess: workspace owned by user
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]);
      // Mock get workspace
      mockDb.limit.mockResolvedValueOnce([mockWorkspace]);

      const res = await app.request("/organizations/org-1/workspaces/ws-1");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(mockWorkspace);
    });

    it("should return 404 if workspace not found", async () => {
      mockSession({ id: "user-1", role: "user" });

      // Mock requireOrgAccess: return member role
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
      // Mock requireWorkspaceAccess: workspace not found
      mockDb.limit.mockResolvedValueOnce([]);

      const res = await app.request("/organizations/org-1/workspaces/ws-1");
      expect(res.status).toBe(404);
    });
  });

  describe("PUT /organizations/:orgId/workspaces/:workspaceId", () => {
    it("should update workspace if owner", async () => {
      mockSession({ id: "user-1", role: "user" });
      const mockWorkspace = { id: "ws-1", name: "Updated WS" };

      // Mock requireOrgAccess: return member role
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
      // Mock requireWorkspaceAccess: workspace owned by user
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]);

      // Mock update
      mockDb.returning.mockResolvedValueOnce([mockWorkspace]);

      const res = await app.request("/organizations/org-1/workspaces/ws-1", {
        method: "PUT",
        body: JSON.stringify({ name: "Updated WS" }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(mockWorkspace);
    });
  });

  describe("DELETE /organizations/:orgId/workspaces/:workspaceId", () => {
    it("should delete workspace if owner", async () => {
      mockSession({ id: "user-1", role: "user" });

      // Mock requireOrgAccess: return member role
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
      // Mock requireWorkspaceAccess: workspace owned by user
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]);

      // Mock delete
      mockDb.where
        .mockReturnValueOnce(mockDb)
        .mockReturnValueOnce(mockDb)
        .mockReturnValueOnce(mockDb)
        .mockResolvedValueOnce([]);

      const res = await app.request("/organizations/org-1/workspaces/ws-1", {
        method: "DELETE",
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ message: "Workspace deleted" });
    });
  });
});
