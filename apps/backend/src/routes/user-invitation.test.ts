import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockDb, mockSession, resetMockDb } from "../test-utils.ts";
import app from "../server.ts";

describe("User Invitation Routes", () => {
  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
    mockDb.where.mockReturnValue(mockDb);
    mockDb.innerJoin.mockReturnValue(mockDb);
  });

  const baseUrl = "/users/me/invitations";

  describe("GET /", () => {
    it("should list pending invitations for user", async () => {
      mockSession({ id: "u1", email: "user@example.com", role: "user" });
      
      const futureDate = new Date();
      futureDate.setDate(futureDate.getDate() + 7);
      
      const mockInvitations = [
        { 
          id: "inv-1", 
          email: "user@example.com", 
          status: "pending", 
          expiresAt: futureDate.toISOString(),
          organisationName: "Org 1",
          workspaceName: "WS 1",
          invitedByName: "Admin"
        }
      ];
      
      mockDb.where.mockResolvedValueOnce(mockInvitations);

      const res = await app.request(baseUrl);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ results: mockInvitations });
    });
  });

  describe("POST /:invitationId/accept", () => {
    it("should accept invitation", async () => {
      mockSession({ id: "u1", email: "user@example.com", role: "user" });
      
      const futureDate = new Date();
      futureDate.setDate(futureDate.getDate() + 7);
      
      const mockInvitation = { 
        id: "inv-1", 
        email: "user@example.com", 
        status: "pending", 
        expiresAt: futureDate.toISOString(),
        organisationId: "org-1",
        workspaceId: "ws-1",
        role: "editor"
      };
      
      mockDb.limit.mockResolvedValueOnce([mockInvitation]); // fetch invitation
      
      // Transaction mocks
      mockDb.limit.mockResolvedValueOnce([]); // check org membership (none)
      
      const res = await app.request(`${baseUrl}/inv-1/accept`, {
        method: "POST",
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ message: "Invitation accepted" });
      expect(mockDb.transaction).toHaveBeenCalled();
    });

    it("should return 410 if invitation expired", async () => {
      mockSession({ id: "u1", email: "user@example.com", role: "user" });
      
      const pastDate = new Date();
      pastDate.setDate(pastDate.getDate() - 1);
      
      const mockInvitation = { 
        id: "inv-1", 
        email: "user@example.com", 
        status: "pending", 
        expiresAt: pastDate.toISOString()
      };
      
      mockDb.limit.mockResolvedValueOnce([mockInvitation]);

      const res = await app.request(`${baseUrl}/inv-1/accept`, {
        method: "POST",
      });

      expect(res.status).toBe(410);
      expect(await res.json()).toEqual({ message: "Invitation has expired" });
    });
  });

  describe("POST /:invitationId/decline", () => {
    it("should decline invitation", async () => {
      mockSession({ id: "u1", email: "user@example.com", role: "user" });
      
      mockDb.returning.mockResolvedValueOnce([{ id: "inv-1", status: "declined" }]);

      const res = await app.request(`${baseUrl}/inv-1/decline`, {
        method: "POST",
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ message: "Invitation declined" });
    });
  });
});
