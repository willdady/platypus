import { describe, it, expect, beforeEach, vi } from "vitest";
import { Hono } from "hono";
import { mockDb, resetMockDb } from "../test-utils.ts";
import type { Variables } from "../server.ts";
import {
  orgScopeOf,
  requireOrgAccess,
  requireWorkspaceAccess,
  requireSuperAdmin,
  workspaceScopeOf,
} from "./authorization.ts";

describe("Authorization Middleware", () => {
  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
    mockDb.where.mockReturnValue(mockDb);
  });

  describe("requireOrgAccess", () => {
    it("should allow super admin to bypass checks", async () => {
      const app = new Hono<{
        Variables: { user: unknown; orgMembership: unknown; db: unknown };
      }>();
      app.use("*", async (c, next) => {
        c.set("user", { id: "admin-1", role: "admin" });
        c.set("db", mockDb);
        await next();
      });
      app.use("*", requireOrgAccess());
      app.get("/test", (c) => c.json(c.get("orgMembership")));

      const res = await app.request("/test");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ role: "admin", isSuperAdmin: true });
    });

    it("should return 403 if user is not a member of the organization", async () => {
      mockDb.limit.mockResolvedValueOnce([]); // No membership found

      const app = new Hono<{ Variables: { user: unknown; db: unknown } }>();
      app.use("*", async (c, next) => {
        c.set("user", { id: "u1", role: "user" });
        c.set("db", mockDb);
        await next();
      });
      app.use("/organizations/:orgId/*", requireOrgAccess());
      app.get("/organizations/:orgId/test", (c) => c.text("ok"));

      const res = await app.request("/organizations/org-1/test");
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({
        error: "Not a member of this organization",
      });
    });

    it("should set orgMembership if user is a member", async () => {
      const mockMembership = {
        organizationId: "org-1",
        userId: "u1",
        role: "member",
      };
      mockDb.limit.mockResolvedValueOnce([mockMembership]);

      const app = new Hono<{
        Variables: { user: unknown; orgMembership: unknown; db: unknown };
      }>();
      app.use("*", async (c, next) => {
        c.set("user", { id: "u1", role: "user" });
        c.set("db", mockDb);
        await next();
      });
      app.use("/organizations/:orgId/*", requireOrgAccess());
      app.get("/organizations/:orgId/test", (c) =>
        c.json(c.get("orgMembership")),
      );

      const res = await app.request("/organizations/org-1/test");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(mockMembership);
    });
  });

  describe("requireWorkspaceAccess", () => {
    // Routes are mounted under :orgId so the cross-org guard can compare the
    // resolved workspace's organizationId against the path orgId.
    const buildApp = (
      user: unknown,
      orgMembership: unknown,
    ): Hono<{
      Variables: {
        user: unknown;
        orgMembership: unknown;
        orgScope: unknown;
        isWorkspaceOwner: unknown;
        db: unknown;
      };
    }> => {
      const app = new Hono<{
        Variables: {
          user: unknown;
          orgMembership: unknown;
          orgScope: unknown;
          isWorkspaceOwner: unknown;
          db: unknown;
        };
      }>();
      app.use("*", async (c, next) => {
        c.set("user", user);
        // Both of these are what requireOrgAccess leaves behind; this stub
        // stands in for it, so requireWorkspaceAccess sees its prerequisite.
        c.set("orgMembership", orgMembership);
        c.set("orgScope", {
          orgId: "org-1",
          principal: { kind: "user", userId: "u1", name: "Ada" },
        });
        c.set("db", mockDb);
        await next();
      });
      app.use(
        "/organizations/:orgId/workspaces/:workspaceId/*",
        requireWorkspaceAccess,
      );
      app.get("/organizations/:orgId/workspaces/:workspaceId/test", (c) =>
        c.json({ isWorkspaceOwner: c.get("isWorkspaceOwner") }),
      );
      return app;
    };

    it("should allow super admin to bypass workspace checks", async () => {
      // Mock workspace lookup for super admin
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "other-user", organizationId: "org-1" },
      ]);

      const app = buildApp(
        { id: "admin-1", role: "admin" },
        { role: "admin", isSuperAdmin: true },
      );

      const res = await app.request(
        "/organizations/org-1/workspaces/ws-1/test",
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ isWorkspaceOwner: false });
    });

    it("should allow org admin to bypass workspace checks", async () => {
      // Workspace lookup
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "other-user", organizationId: "org-1" },
      ]);

      const app = buildApp({ id: "u1", role: "user" }, { role: "admin" });

      const res = await app.request(
        "/organizations/org-1/workspaces/ws-1/test",
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ isWorkspaceOwner: false });
    });

    it("should allow workspace owner access", async () => {
      // Workspace lookup - user is owner
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "u1", organizationId: "org-1" },
      ]);

      const app = buildApp({ id: "u1", role: "user" }, { role: "member" });

      const res = await app.request(
        "/organizations/org-1/workspaces/ws-1/test",
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ isWorkspaceOwner: true });
    });

    it("should return 403 if user is not workspace owner", async () => {
      // Workspace lookup - user is not owner
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "other-user", organizationId: "org-1" },
      ]);

      const app = buildApp({ id: "u1", role: "user" }, { role: "member" });

      const res = await app.request(
        "/organizations/org-1/workspaces/ws-1/test",
      );
      expect(res.status).toBe(403);
    });

    it("should return 404 if workspace not found", async () => {
      // Workspace lookup - not found
      mockDb.limit.mockResolvedValueOnce([]);

      const app = buildApp({ id: "u1", role: "user" }, { role: "member" });

      const res = await app.request(
        "/organizations/org-1/workspaces/ws-1/test",
      );
      expect(res.status).toBe(404);
    });

    it("should return 404 when workspace belongs to a different org (member)", async () => {
      // Workspace exists but lives in org-2 while the path names org-1.
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "u1", organizationId: "org-2" },
      ]);

      const app = buildApp({ id: "u1", role: "user" }, { role: "member" });

      const res = await app.request(
        "/organizations/org-1/workspaces/ws-1/test",
      );
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Workspace not found" });
    });

    it("should return 404 when workspace belongs to a different org (org admin)", async () => {
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "other-user", organizationId: "org-2" },
      ]);

      const app = buildApp({ id: "u1", role: "user" }, { role: "admin" });

      const res = await app.request(
        "/organizations/org-1/workspaces/ws-1/test",
      );
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Workspace not found" });
    });

    it("should return 404 when workspace belongs to a different org (super admin)", async () => {
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "other-user", organizationId: "org-2" },
      ]);

      const app = buildApp(
        { id: "admin-1", role: "admin" },
        { role: "admin", isSuperAdmin: true },
      );

      const res = await app.request(
        "/organizations/org-1/workspaces/ws-1/test",
      );
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Workspace not found" });
    });
  });

  describe("scope accessors", () => {
    /**
     * A route under the real middleware chain, so the accessors are read
     * exactly where a handler reads them.
     */
    const buildApp = (user: {
      id: string;
      role: string;
    }): Hono<{ Variables: Variables }> => {
      const app = new Hono<{ Variables: Variables }>();
      app.use("*", async (c, next) => {
        // requireAuth would set both; stand in for it.
        c.set("user", user as never);
        c.set("userScope", {
          principal: { kind: "user", userId: user.id, name: "Ada" },
        });
        c.set("db", mockDb as never);
        await next();
      });
      app.get("/organizations/:orgId/only", requireOrgAccess(), (c) =>
        c.json(orgScopeOf(c)),
      );
      app.get(
        "/organizations/:orgId/workspaces/:workspaceId/test",
        requireOrgAccess(),
        requireWorkspaceAccess,
        (c) => c.json(workspaceScopeOf(c)),
      );
      app.get("/unguarded", (c) => c.json(workspaceScopeOf(c)));
      app.get("/unguarded-org", (c) => c.json(orgScopeOf(c)));
      // Hono turns a handler throw into a 500; surface the message so the
      // wiring mistake is assertable.
      app.onError((err, c) => c.text(err.message, 500));
      return app;
    };

    it("returns the org scope the middleware resolved", async () => {
      mockDb.limit.mockResolvedValueOnce([
        { organizationId: "org-1", userId: "u1", role: "member" },
      ]);

      const app = buildApp({ id: "u1", role: "user" });
      const res = await app.request("/organizations/org-1/only");

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        orgId: "org-1",
        principal: { kind: "user", userId: "u1", name: "Ada" },
      });
    });

    it("returns the workspace scope the middleware resolved", async () => {
      mockDb.limit
        .mockResolvedValueOnce([
          { organizationId: "org-1", userId: "u1", role: "member" },
        ])
        .mockResolvedValueOnce([{ ownerId: "u1", organizationId: "org-1" }]);

      const app = buildApp({ id: "u1", role: "user" });
      const res = await app.request(
        "/organizations/org-1/workspaces/ws-1/test",
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        orgId: "org-1",
        workspaceId: "ws-1",
        isWorkspaceOwner: true,
        principal: { kind: "user", userId: "u1", name: "Ada" },
      });
    });

    it("carries isWorkspaceOwner: false for a non-owning org admin", async () => {
      mockDb.limit
        .mockResolvedValueOnce([
          { organizationId: "org-1", userId: "u1", role: "admin" },
        ])
        .mockResolvedValueOnce([
          { ownerId: "other-user", organizationId: "org-1" },
        ]);

      const app = buildApp({ id: "u1", role: "user" });
      const res = await app.request(
        "/organizations/org-1/workspaces/ws-1/test",
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ isWorkspaceOwner: false });
    });

    it("resolves the scope for a super admin, who bypasses the membership check", async () => {
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "other-user", organizationId: "org-1" },
      ]);

      const app = buildApp({ id: "admin-1", role: "admin" });
      const res = await app.request(
        "/organizations/org-1/workspaces/ws-1/test",
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        orgId: "org-1",
        workspaceId: "ws-1",
        isWorkspaceOwner: false,
      });
    });

    it("throws when the workspace middleware did not run", async () => {
      const app = buildApp({ id: "u1", role: "user" });

      const res = await app.request("/unguarded");
      expect(res.status).toBe(500);
      expect(await res.text()).toMatch(/requireWorkspaceAccess/);
    });

    it("throws when the org middleware did not run", async () => {
      const app = buildApp({ id: "u1", role: "user" });

      const res = await app.request("/unguarded-org");
      expect(res.status).toBe(500);
      expect(await res.text()).toMatch(/requireOrgAccess/);
    });
  });

  describe("requireSuperAdmin", () => {
    it("should return 403 if user is not super admin", async () => {
      const app = new Hono<{ Variables: { user: unknown } }>();
      app.use("*", async (c, next) => {
        c.set("user", { id: "u1", role: "user" });
        await next();
      });
      app.use("*", requireSuperAdmin);
      app.get("/test", (c) => c.text("ok"));

      const res = await app.request("/test");
      expect(res.status).toBe(403);
    });

    it("should allow super admin", async () => {
      const app = new Hono<{ Variables: { user: unknown } }>();
      app.use("*", async (c, next) => {
        c.set("user", { id: "admin-1", role: "admin" });
        await next();
      });
      app.use("*", requireSuperAdmin);
      app.get("/test", (c) => c.text("ok"));

      const res = await app.request("/test");
      expect(res.status).toBe(200);
    });
  });
});
