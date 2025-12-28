import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockDb, mockSession, mockNoSession, resetMockDb } from "../test-utils.ts";
import app from "../server.ts";

describe("Organization Routes", () => {
  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
  });

  describe("POST /organizations", () => {
    it("should return 401 if not authenticated", async () => {
      mockNoSession();
      const res = await app.request("/organizations", {
        method: "POST",
        body: JSON.stringify({ name: "New Org" }),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(401);
    });

    it("should return 403 if not super admin", async () => {
      mockSession({ id: "user-1", role: "user" });
      const res = await app.request("/organizations", {
        method: "POST",
        body: JSON.stringify({ name: "New Org" }),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(403);
    });

    it("should create organization if super admin", async () => {
      mockSession({ id: "admin-1", role: "admin" });
      const mockOrg = { id: "org-1", name: "New Org" };
      mockDb.returning.mockResolvedValue([mockOrg]);

      const res = await app.request("/organizations", {
        method: "POST",
        body: JSON.stringify({ name: "New Org" }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(201);
      expect(await res.json()).toEqual(mockOrg);
      expect(mockDb.insert).toHaveBeenCalled();
    });
  });

  describe("GET /organizations", () => {
    it("should return all organizations for super admin", async () => {
      mockSession({ id: "admin-1", role: "admin" });
      const mockOrgs = [{ id: "org-1", name: "Org 1" }, { id: "org-2", name: "Org 2" }];
      // Mock the chain: select().from() -> resolves to mockOrgs
      mockDb.from.mockResolvedValueOnce(mockOrgs);

      const res = await app.request("/organizations");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ results: mockOrgs });
    });

    it("should return only user's organizations for regular user", async () => {
      mockSession({ id: "user-1", role: "user" });
      const mockMemberships = [{ organizationId: "org-1" }];
      const mockOrgs = [{ id: "org-1", name: "Org 1" }];
      
      // First call: memberships query
      // db.select().from().where()
      mockDb.where.mockResolvedValueOnce(mockMemberships);
      
      // Second call: organizations query
      // db.select().from().where()
      mockDb.where.mockResolvedValueOnce(mockOrgs);

      const res = await app.request("/organizations");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ results: mockOrgs });
    });
  });

  describe("GET /organizations/:orgId", () => {
    it("should return 403 if user has no access", async () => {
      mockSession({ id: "user-1", role: "user" });
      // requireOrgAccess: db.select().from().where().limit(1)
      mockDb.limit.mockResolvedValue([]); // No membership found

      const res = await app.request("/organizations/org-1");
      expect(res.status).toBe(403);
    });

    it("should return organization if user has access", async () => {
      mockSession({ id: "user-1", role: "user" });
      const mockOrg = { id: "org-1", name: "Org 1" };
      
      // requireOrgAccess: db.select().from().where().limit(1)
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
      
      // get organization: db.select().from().where().limit(1)
      mockDb.limit.mockResolvedValueOnce([mockOrg]);

      const res = await app.request("/organizations/org-1");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(mockOrg);
    });
  });
});
