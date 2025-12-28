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
    it("should return 403 if not org admin", async () => {
      mockSession({ id: "user-1", role: "user" });

      // Mock requireOrgAccess: return member role
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);

      const res = await app.request("/organizations/org-1/workspaces", {
        method: "POST",
        body: JSON.stringify({ name: "New Workspace" }),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(403);
    });

    it("should create workspace if org admin", async () => {
      mockSession({ id: "user-1", role: "user" });

      // Mock requireOrgAccess: return admin role
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]);

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
      // This query ends in where(), so we mock where()
      // First call is for requireOrgAccess (returns mockDb), second is for list workspaces (returns data)
      mockDb.where
        .mockReturnValueOnce(mockDb)
        .mockResolvedValueOnce(mockWorkspaces);

      const res = await app.request("/organizations/org-1/workspaces");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ results: mockWorkspaces });
    });

    it("should return only member workspaces for regular member", async () => {
      mockSession({ id: "user-1", role: "user" });
      const mockWorkspaces = [{ id: "ws-1", name: "WS 1" }];
      const mockMemberships = [{ workspaceId: "ws-1" }];

      // Mock requireOrgAccess: return member role
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);

      // Mock get workspace memberships (ends in where)
      // First call is for requireOrgAccess (returns mockDb)
      // Second call is for get workspace memberships (returns data)
      // Third call is for get workspaces by IDs (returns data)
      mockDb.where
        .mockReturnValueOnce(mockDb)
        .mockResolvedValueOnce(mockMemberships)
        .mockResolvedValueOnce(mockWorkspaces);

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

      // Mock get workspace (ends in limit)
      mockDb.limit.mockResolvedValueOnce([mockWorkspace]);

      const res = await app.request("/organizations/org-1/workspaces/ws-1");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(mockWorkspace);
    });

    it("should return 404 if workspace not found", async () => {
      mockSession({ id: "user-1", role: "user" });

      // Mock requireOrgAccess: return member role
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);

      // Mock get workspace (empty)
      mockDb.limit.mockResolvedValueOnce([]);

      const res = await app.request("/organizations/org-1/workspaces/ws-1");
      expect(res.status).toBe(404);
    });
  });

  describe("PUT /organizations/:orgId/workspaces/:workspaceId", () => {
    it("should update workspace if org admin", async () => {
      mockSession({ id: "user-1", role: "user" });
      const mockWorkspace = { id: "ws-1", name: "Updated WS" };

      // Mock requireOrgAccess: return admin role
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]);

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
    it("should delete workspace if org admin", async () => {
      mockSession({ id: "user-1", role: "user" });

      // Mock requireOrgAccess: return admin role
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]);

      // Mock delete (returns nothing or whatever)
      // First call is for requireOrgAccess (returns mockDb)
      // Second call is for delete (returns data)
      mockDb.where.mockReturnValueOnce(mockDb).mockResolvedValueOnce([]);

      const res = await app.request("/organizations/org-1/workspaces/ws-1", {
        method: "DELETE",
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ message: "Workspace deleted" });
    });
  });
});
