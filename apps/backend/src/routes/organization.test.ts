import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  mockDb,
  mockSession,
  mockNoSession,
  resetMockDb,
} from "../test-utils.ts";
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
      const mockOrgs = [
        { id: "org-1", name: "Org 1" },
        { id: "org-2", name: "Org 2" },
      ];
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

  describe("PUT /organizations/:orgId", () => {
    const put = (body: unknown) =>
      app.request("/organizations/org-1", {
        method: "PUT",
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
      });

    it("should return 403 if user is not an org admin", async () => {
      mockSession({ id: "user-1", role: "user" });
      // requireOrgAccess(["admin"]): membership lookup returns a non-admin role
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);

      const res = await put({ name: "Renamed Org" });
      expect(res.status).toBe(403);
    });

    it("should reject an override above the env ceiling with 400", async () => {
      // Super admin bypasses requireOrgAccess (no membership query consumed).
      mockSession({ id: "admin-1", role: "admin" });

      // Default chat per-run ceiling is 10 min (600000 ms); exceed it.
      const res = await put({
        name: "Valid Org",
        agentRunSettings: { chatPerRunTimeoutMs: 999_999_999 },
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      // Convention: errors use the singular `error` key.
      expect(body.error).toContain("RUN_PER_RUN_TIMEOUT_MS");
      expect(mockDb.update).not.toHaveBeenCalled();
    });

    it("should persist an override within the ceiling", async () => {
      mockSession({ id: "admin-1", role: "admin" });
      const updated = {
        id: "org-1",
        name: "Valid Org",
        agentRunSettings: { chatPerRunTimeoutMs: 60_000 },
      };
      mockDb.returning.mockResolvedValueOnce([updated]);

      const res = await put({
        name: "Valid Org",
        agentRunSettings: { chatPerRunTimeoutMs: 60_000 },
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([updated]);
      expect(mockDb.update).toHaveBeenCalled();
    });

    it("should clear the override when agentRunSettings is null", async () => {
      mockSession({ id: "admin-1", role: "admin" });
      const cleared = {
        id: "org-1",
        name: "Valid Org",
        agentRunSettings: null,
      };
      mockDb.returning.mockResolvedValueOnce([cleared]);

      const res = await put({ name: "Valid Org", agentRunSettings: null });

      // null is falsy, so the ceiling validation is skipped and the row is
      // written with a null override (back to env / hardcoded defaults).
      expect(res.status).toBe(200);
      expect(mockDb.set).toHaveBeenCalledWith(
        expect.objectContaining({ agentRunSettings: null }),
      );
    });
  });
});
