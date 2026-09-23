import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  mockDb,
  mockSession,
  mockNoSession,
  resetMockDb,
  seedDb,
  useTempDiskStorage,
  putStoredFiles,
  isStored,
} from "../test-utils.ts";
import { mockLogger } from "../test-setup.ts";
import { getStorage } from "../storage/index.ts";
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
    it("should accept and persist identityContext for an admin", async () => {
      mockSession({ id: "admin-1", role: "user" });
      const updated = {
        id: "org-1",
        name: "Org 1",
        identityContext: "We are Acme.",
      };

      // requireOrgAccess(["admin"]): db.select().from().where().limit(1)
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]);
      // update: db.update().set().where().returning()
      mockDb.returning.mockResolvedValueOnce([updated]);

      const res = await app.request("/organizations/org-1", {
        method: "PUT",
        body: JSON.stringify({
          name: "Org 1",
          identityContext: "We are Acme.",
        }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(200);
      // Handler returns the raw returning() array.
      expect(await res.json()).toEqual([updated]);
      expect(mockDb.set).toHaveBeenCalledWith(
        expect.objectContaining({ identityContext: "We are Acme." }),
      );
    });
  });

  describe("DELETE /organizations/:orgId", () => {
    useTempDiskStorage();

    const inside = [
      "org-1/ws-1/chat-1/msg-1/0-aaaaaaaa.png",
      "org-1/ws-2/chat-2/msg-1/0-bbbbbbbb.png",
    ];
    const avatars = [
      "agents/org-agent/avatar-a.webp",
      "agents/ws-agent/avatar-b.webp",
    ];
    const outside = [
      "org-10/ws-3/chat-3/msg-1/0-cccccccc.png",
      "agents/other-agent/avatar-c.webp",
    ];

    const seed = () =>
      seedDb({
        organization: [{ id: "org-1" }, { id: "org-10" }],
        organization_member: [
          {
            id: "m1",
            userId: "admin-1",
            organizationId: "org-1",
            role: "admin",
          },
        ],
        workspace: [
          { id: "ws-1", organizationId: "org-1" },
          { id: "ws-2", organizationId: "org-1" },
          { id: "ws-3", organizationId: "org-10" },
        ],
        agent: [
          { id: "org-agent", organizationId: "org-1", avatarKey: avatars[0] },
          { id: "ws-agent", workspaceId: "ws-2", avatarKey: avatars[1] },
          { id: "other-agent", workspaceId: "ws-3", avatarKey: outside[1] },
        ],
      });

    it("removes the Organization's files and every cascaded Agent's avatar, and nothing else", async () => {
      mockSession({ id: "admin-1", role: "user" });
      seed();
      await putStoredFiles([...inside, ...avatars, ...outside]);

      const res = await app.request("/organizations/org-1", {
        method: "DELETE",
      });

      expect(res.status).toBe(200);
      for (const key of [...inside, ...avatars]) {
        expect(await isStored(key)).toBe(false);
      }
      for (const key of outside) {
        expect(await isStored(key)).toBe(true);
      }
    });

    it("leaves storage untouched when the DB delete fails", async () => {
      mockSession({ id: "admin-1", role: "user" });
      const fake = seed();
      await putStoredFiles([...inside, ...avatars]);
      vi.spyOn(
        fake.handle as { delete: () => never },
        "delete",
      ).mockImplementation(() => {
        throw new Error("db down");
      });

      const res = await app.request("/organizations/org-1", {
        method: "DELETE",
      });

      expect(res.status).toBe(500);
      for (const key of [...inside, ...avatars]) {
        expect(await isStored(key)).toBe(true);
      }
    });

    it("still succeeds, and logs, when storage fails after the DB delete", async () => {
      mockSession({ id: "admin-1", role: "user" });
      const fake = seed();
      vi.spyOn(getStorage(), "deletePrefix").mockRejectedValue(
        new Error("storage down"),
      );

      const res = await app.request("/organizations/org-1", {
        method: "DELETE",
      });

      expect(res.status).toBe(200);
      expect(fake.tables.organization.map((row) => row.id)).toEqual(["org-10"]);
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ prefix: "org-1/" }),
        "Failed to delete files from storage",
      );
    });
  });
});
