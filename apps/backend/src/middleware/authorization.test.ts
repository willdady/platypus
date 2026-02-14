import { describe, it, expect, beforeEach, vi } from "vitest";
import { Hono } from "hono";
import { mockDb, resetMockDb } from "../test-utils.ts";
import {
  requireOrgAccess,
  requireWorkspaceAccess,
  requireSuperAdmin,
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
        Variables: { user: any; orgMembership: any; db: any };
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

      const app = new Hono<{ Variables: { user: any; db: any } }>();
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
        Variables: { user: any; orgMembership: any; db: any };
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
    it("should allow super admin to bypass workspace checks", async () => {
      const app = new Hono<{
        Variables: {
          user: any;
          orgMembership: any;
          isWorkspaceOwner: any;
          db: any;
        };
      }>();
      app.use("*", async (c, next) => {
        c.set("user", { id: "admin-1", role: "admin" });
        c.set("orgMembership", { role: "admin", isSuperAdmin: true });
        c.set("db", mockDb);
        await next();
      });
      app.use("/workspaces/:workspaceId/*", requireWorkspaceAccess);
      app.get("/workspaces/:workspaceId/test", (c) =>
        c.json({ isWorkspaceOwner: c.get("isWorkspaceOwner") }),
      );

      const res = await app.request("/workspaces/ws-1/test");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ isWorkspaceOwner: false });
    });

    it("should allow org admin to bypass workspace checks", async () => {
      // Workspace lookup
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "other-user" }]);

      const app = new Hono<{
        Variables: {
          user: any;
          orgMembership: any;
          isWorkspaceOwner: any;
          db: any;
        };
      }>();
      app.use("*", async (c, next) => {
        c.set("user", { id: "u1", role: "user" });
        c.set("orgMembership", { role: "admin" });
        c.set("db", mockDb);
        await next();
      });
      app.use("/workspaces/:workspaceId/*", requireWorkspaceAccess);
      app.get("/workspaces/:workspaceId/test", (c) =>
        c.json({ isWorkspaceOwner: c.get("isWorkspaceOwner") }),
      );

      const res = await app.request("/workspaces/ws-1/test");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ isWorkspaceOwner: false });
    });

    it("should allow workspace owner access", async () => {
      // Workspace lookup - user is owner
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "u1" }]);

      const app = new Hono<{
        Variables: {
          user: any;
          orgMembership: any;
          isWorkspaceOwner: any;
          db: any;
        };
      }>();
      app.use("*", async (c, next) => {
        c.set("user", { id: "u1", role: "user" });
        c.set("orgMembership", { role: "member" });
        c.set("db", mockDb);
        await next();
      });
      app.use("/workspaces/:workspaceId/*", requireWorkspaceAccess);
      app.get("/workspaces/:workspaceId/test", (c) =>
        c.json({ isWorkspaceOwner: c.get("isWorkspaceOwner") }),
      );

      const res = await app.request("/workspaces/ws-1/test");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ isWorkspaceOwner: true });
    });

    it("should return 403 if user is not workspace owner", async () => {
      // Workspace lookup - user is not owner
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "other-user" }]);

      const app = new Hono<{
        Variables: {
          user: any;
          orgMembership: any;
          isWorkspaceOwner: any;
          db: any;
        };
      }>();
      app.use("*", async (c, next) => {
        c.set("user", { id: "u1", role: "user" });
        c.set("orgMembership", { role: "member" });
        c.set("db", mockDb);
        await next();
      });
      app.use("/workspaces/:workspaceId/*", requireWorkspaceAccess);
      app.get("/workspaces/:workspaceId/test", (c) => c.text("ok"));

      const res = await app.request("/workspaces/ws-1/test");
      expect(res.status).toBe(403);
    });

    it("should return 404 if workspace not found", async () => {
      // Workspace lookup - not found
      mockDb.limit.mockResolvedValueOnce([]);

      const app = new Hono<{
        Variables: {
          user: any;
          orgMembership: any;
          isWorkspaceOwner: any;
          db: any;
        };
      }>();
      app.use("*", async (c, next) => {
        c.set("user", { id: "u1", role: "user" });
        c.set("orgMembership", { role: "member" });
        c.set("db", mockDb);
        await next();
      });
      app.use("/workspaces/:workspaceId/*", requireWorkspaceAccess);
      app.get("/workspaces/:workspaceId/test", (c) => c.text("ok"));

      const res = await app.request("/workspaces/ws-1/test");
      expect(res.status).toBe(404);
    });
  });

  describe("requireSuperAdmin", () => {
    it("should return 403 if user is not super admin", async () => {
      const app = new Hono<{ Variables: { user: any } }>();
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
      const app = new Hono<{ Variables: { user: any } }>();
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
