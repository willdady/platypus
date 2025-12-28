import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockDb, mockSession, resetMockDb } from "../test-utils.ts";
import app from "../server.ts";

describe("Invitation Routes", () => {
  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
    mockDb.where.mockReturnValue(mockDb);
    mockDb.innerJoin.mockReturnValue(mockDb);
  });

  const orgId = "org-1";
  const baseUrl = `/organizations/${orgId}/invitations`;

  describe("POST /", () => {
    it("should create invitation if org admin", async () => {
      mockSession({ id: "admin-1", email: "admin@example.com", role: "user" });
      // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]);
      // Verify workspace belongs to org
      mockDb.limit.mockResolvedValueOnce([{ id: "ws-1", organizationId: orgId }]);
      
      const mockInvitation = { id: "inv-1", email: "user@example.com", workspaceId: "ws-1" };
      mockDb.returning.mockResolvedValueOnce([mockInvitation]);

      const res = await app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify({ 
          email: "user@example.com", 
          workspaceId: "ws-1",
          role: "editor"
        }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(201);
      expect(await res.json()).toEqual(mockInvitation);
    });

    it("should return 400 if inviting self", async () => {
      mockSession({ id: "admin-1", email: "admin@example.com", role: "user" });
      // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]);

      const res = await app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify({ 
          email: "admin@example.com", 
          workspaceId: "ws-1",
          role: "editor"
        }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ message: "You cannot invite yourself" });
    });
  });

  describe("GET /", () => {
    it("should list invitations", async () => {
      mockSession();
      // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]);
      
      const mockInvitations = [{ id: "inv-1", email: "user@example.com", workspaceName: "WS 1" }];
      mockDb.where
        .mockReturnValueOnce(mockDb)
        .mockResolvedValueOnce(mockInvitations);

      const res = await app.request(baseUrl);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ results: mockInvitations });
    });
  });

  describe("DELETE /:invitationId", () => {
    it("should delete invitation", async () => {
      mockSession();
      // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]);
      
      mockDb.where
        .mockReturnValueOnce(mockDb)
        .mockReturnValueOnce(mockDb);
      mockDb.returning.mockResolvedValueOnce([{ id: "inv-1" }]);

      const res = await app.request(`${baseUrl}/inv-1`, {
        method: "DELETE",
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ message: "Invitation deleted" });
    });
  });
});
