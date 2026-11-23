import { describe, it, expect, beforeEach, vi } from "vitest";
import { Hono } from "hono";
import { mockDb, resetMockDb } from "../test-utils.ts";
import type { Variables } from "../server.ts";
import {
  orgMembershipOf,
  orgScopeOf,
  requireOrgAccess,
  requireWorkspaceAccess,
  requireSuperAdmin,
  userOf,
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
      const app = new Hono<{ Variables: Variables }>();
      app.use("*", async (c, next) => {
        c.set("user", { id: "admin-1", role: "admin" } as never);
        await next();
      });
      app.use("*", requireOrgAccess());
      app.get("/test", (c) => c.json(c.get("orgMembership")));

      const res = await app.request("/test");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ role: "admin", isSuperAdmin: true });
    });

    it("should return 403 if user is not a member of the organization", async () => {
      mockDb.limit.mockResolvedValueOnce([]);

      const app = new Hono<{ Variables: Variables }>();
      app.use("*", async (c, next) => {
        c.set("user", { id: "u1", role: "user" } as never);
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

      const app = new Hono<{ Variables: Variables }>();
      app.use("*", async (c, next) => {
        c.set("user", { id: "u1", role: "user" } as never);
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
    const buildApp = (
      user: unknown,
      orgMembership: unknown,
    ): Hono<{ Variables: Variables }> => {
      const app = new Hono<{ Variables: Variables }>();
      app.use("*", async (c, next) => {
        c.set("user", user as never);
        c.set("orgMembership", orgMembership as never);
        c.set("orgScope", {
          orgId: "org-1",
          principal: { kind: "user", userId: "u1", name: "Ada" },
        });
        await next();
      });
      app.use(
        "/organizations/:orgId/workspaces/:workspaceId/*",
        requireWorkspaceAccess,
      );
      app.get("/organizations/:orgId/workspaces/:workspaceId/test", (c) =>
        c.json({ isWorkspaceOwner: workspaceScopeOf(c).isWorkspaceOwner }),
      );
      return app;
    };

    it("should allow super admin to bypass workspace checks", async () => {
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
      mockDb.limit.mockResolvedValueOnce([]);

      const app = buildApp({ id: "u1", role: "user" }, { role: "member" });

      const res = await app.request(
        "/organizations/org-1/workspaces/ws-1/test",
      );
      expect(res.status).toBe(404);
    });

    it("hides a workspace in another org behind the not-found 404 (member)", async () => {
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

    it("hides a workspace in another org behind the not-found 404 (org admin)", async () => {
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

    it("hides a workspace in another org behind the not-found 404 (super admin)", async () => {
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
    const buildApp = (user: {
      id: string;
      role: string;
      name: string;
    }): Hono<{ Variables: Variables }> => {
      const app = new Hono<{ Variables: Variables }>();
      app.use("*", async (c, next) => {
        c.set("user", user as never);
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
      app.get("/organizations/:orgId/membership", requireOrgAccess(), (c) =>
        c.json({ user: userOf(c).id, membership: orgMembershipOf(c) }),
      );
      app.get("/unguarded-membership", (c) => c.json(orgMembershipOf(c)));
      app.onError((err, c) => c.text(err.message, 500));
      return app;
    };

    it("returns the org scope the middleware resolved", async () => {
      mockDb.limit.mockResolvedValueOnce([
        { organizationId: "org-1", userId: "u1", role: "member" },
      ]);

      const app = buildApp({ id: "u1", role: "user", name: "Ada" });
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

      const app = buildApp({ id: "u1", role: "user", name: "Ada" });
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

      const app = buildApp({ id: "u1", role: "user", name: "Ada" });
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

      const app = buildApp({ id: "admin-1", role: "admin", name: "Ada" });
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
      const app = buildApp({ id: "u1", role: "user", name: "Ada" });

      const res = await app.request("/unguarded");
      expect(res.status).toBe(500);
      expect(await res.text()).toMatch(/requireWorkspaceAccess/);
    });

    it("throws when the org middleware did not run", async () => {
      const app = buildApp({ id: "u1", role: "user", name: "Ada" });

      const res = await app.request("/unguarded-org");
      expect(res.status).toBe(500);
      expect(await res.text()).toMatch(/requireOrgAccess/);
    });

    it("returns the user and org membership the middleware resolved", async () => {
      mockDb.limit.mockResolvedValueOnce([
        { organizationId: "org-1", userId: "u1", role: "member" },
      ]);

      const app = buildApp({ id: "u1", role: "user", name: "Ada" });
      const res = await app.request("/organizations/org-1/membership");

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        user: "u1",
        membership: { organizationId: "org-1", userId: "u1", role: "member" },
      });
    });

    it("throws from orgMembershipOf when the org middleware did not run", async () => {
      const app = buildApp({ id: "u1", role: "user", name: "Ada" });

      const res = await app.request("/unguarded-membership");
      expect(res.status).toBe(500);
      expect(await res.text()).toMatch(/requireOrgAccess/);
    });

    it("throws from userOf when requireAuth did not run", async () => {
      const app = new Hono<{ Variables: Variables }>();
      app.get("/unauthenticated", (c) => c.json(userOf(c)));
      app.onError((err, c) => c.text(err.message, 500));

      const res = await app.request("/unauthenticated");
      expect(res.status).toBe(500);
      expect(await res.text()).toMatch(/requireAuth/);
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
