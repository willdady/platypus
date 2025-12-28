import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockDb, mockSession, resetMockDb } from "../test-utils.ts";
import app from "../server.ts";

describe("Member Routes", () => {
  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
    mockDb.where.mockReturnValue(mockDb);
    mockDb.innerJoin.mockReturnValue(mockDb);
  });

  const orgId = "org-1";
  const baseUrl = `/organizations/${orgId}/members`;

  describe("GET /", () => {
    it("should list organization members", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]); // requireOrgAccess
      
      const mockMembers = [
        { 
          id: "m1", 
          userId: "u1", 
          user: { id: "u1", name: "User 1", email: "u1@ex.com", role: "user" } 
        }
      ];
      const mockWorkspaces = [{ workspaceId: "ws-1", workspaceName: "WS 1", role: "admin" }];
      
      mockDb.where
        .mockReturnValueOnce(mockDb) // requireOrgAccess
        .mockResolvedValueOnce(mockMembers) // list members
        .mockResolvedValueOnce(mockWorkspaces); // list workspaces for member 1

      const res = await app.request(baseUrl);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.results[0].id).toBe("m1");
      expect(json.results[0].workspaces).toEqual(mockWorkspaces);
    });
  });

  describe("PATCH /:memberId", () => {
    it("should update member role", async () => {
      mockSession({ id: "admin-1", role: "user" });
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]); // requireOrgAccess
      
      // Target member
      mockDb.limit.mockResolvedValueOnce([{ id: "m1", userId: "u1", role: "member" }]);
      
      const mockUpdated = { id: "m1", role: "admin" };
      mockDb.returning.mockResolvedValueOnce([mockUpdated]);

      const res = await app.request(`${baseUrl}/m1`, {
        method: "PATCH",
        body: JSON.stringify({ role: "admin" }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(mockUpdated);
    });

    it("should return 400 if demoting self", async () => {
      mockSession({ id: "admin-1", role: "user" });
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]); // requireOrgAccess
      
      // Target member is self
      mockDb.limit.mockResolvedValueOnce([{ id: "m1", userId: "admin-1", role: "admin" }]);

      const res = await app.request(`${baseUrl}/m1`, {
        method: "PATCH",
        body: JSON.stringify({ role: "member" }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "You cannot demote yourself from admin" });
    });
  });

  describe("POST /:memberId/workspaces", () => {
    it("should add member to workspace", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]); // requireOrgAccess
      
      // Fetch member
      mockDb.limit.mockResolvedValueOnce([{ id: "m1", userId: "u1" }]);
      // Verify workspace
      mockDb.limit.mockResolvedValueOnce([{ id: "ws-1", organizationId: orgId }]);
      // Check if already member
      mockDb.limit.mockResolvedValueOnce([]);
      
      const mockWsMember = { id: "wsm1", workspaceId: "ws-1", userId: "u1", role: "editor" };
      mockDb.returning.mockResolvedValueOnce([mockWsMember]);

      const res = await app.request(`${baseUrl}/m1/workspaces`, {
        method: "POST",
        body: JSON.stringify({ workspaceId: "ws-1", role: "editor" }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(201);
      expect(await res.json()).toEqual(mockWsMember);
    });
  });
});
