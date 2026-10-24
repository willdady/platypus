import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  dbError,
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
import { z } from "zod";
import {
  clearSandboxBackends,
  registerSandboxBackend,
} from "../sandbox/index.ts";
import type { SandboxBackend } from "../sandbox/types.ts";

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
      const fake = seedDb();
      const res = await app.request("/organizations", {
        method: "POST",
        body: JSON.stringify({ name: "New Org" }),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(403);
      expect(fake.tables.organization ?? []).toEqual([]);
    });

    it("should create organization if super admin", async () => {
      mockSession({ id: "admin-1", role: "admin" });
      const fake = seedDb();

      const res = await app.request("/organizations", {
        method: "POST",
        body: JSON.stringify({ name: "New Org" }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as { id: string; name: string };
      expect(body).toMatchObject({ name: "New Org" });
      expect(fake.tables.organization).toEqual([
        expect.objectContaining({ id: body.id, name: "New Org" }),
      ]);
    });
  });

  describe("GET /organizations", () => {
    const seedOrgs = () =>
      seedDb({
        organization: [{ id: "org-1" }, { id: "org-2" }, { id: "org-3" }],
        organization_member: [
          { id: "m1", userId: "user-1", organizationId: "org-1" },
          { id: "m2", userId: "user-1", organizationId: "org-3" },
          { id: "m3", userId: "user-2", organizationId: "org-2" },
        ],
      });

    const listIds = async () => {
      const res = await app.request("/organizations");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { results: { id: string }[] };
      return body.results.map((o) => o.id);
    };

    it("should return all organizations for super admin", async () => {
      mockSession({ id: "admin-1", role: "admin" });
      seedOrgs();

      expect(await listIds()).toEqual(["org-1", "org-2", "org-3"]);
    });

    it("should return only user's organizations for regular user", async () => {
      mockSession({ id: "user-1", role: "user" });
      seedOrgs();

      expect(await listIds()).toEqual(["org-1", "org-3"]);
    });

    it("returns an empty list for a user with no memberships", async () => {
      mockSession({ id: "user-9", role: "user" });
      seedOrgs();

      expect(await listIds()).toEqual([]);
    });
  });

  describe("GET /organizations/:orgId", () => {
    // `user-1` is a member of `org-1` only; `org-2` is seeded first, so a
    // lookup that dropped its `id` filter returns it.
    const seed = () =>
      seedDb({
        organization: [
          { id: "org-2", name: "Org 2" },
          { id: "org-1", name: "Org 1" },
        ],
        organization_member: [
          {
            id: "m1",
            userId: "user-1",
            organizationId: "org-1",
            role: "member",
          },
          {
            id: "m2",
            userId: "user-2",
            organizationId: "org-2",
            role: "admin",
          },
        ],
      });

    it("should return 403 if user has no access", async () => {
      // A member of `org-1` only: the membership lookup's `organizationId`
      // scope is what keeps `org-2` out of reach.
      mockSession({ id: "user-1", role: "user" });
      seed();

      const res = await app.request("/organizations/org-2");
      expect(res.status).toBe(403);
    });

    it("should return organization if user has access", async () => {
      // Guards the `id` filter: `org-2` must not come back for `org-1`.
      mockSession({ id: "user-1", role: "user" });
      seed();

      const res = await app.request("/organizations/org-1");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ id: "org-1", name: "Org 1" });
    });

    it("returns 404 for a super admin asking for a missing Organization", async () => {
      mockSession({ id: "admin-1", role: "admin" });
      seed();

      const res = await app.request("/organizations/org-9");
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Organization not found" });
    });
  });

  describe("GET /organizations/:orgId/membership", () => {
    it("returns the caller's membership", async () => {
      mockSession({ id: "user-1", role: "user" });
      seedDb({
        organization_member: [
          {
            id: "m1",
            userId: "user-1",
            organizationId: "org-1",
            role: "member",
          },
        ],
      });

      const res = await app.request("/organizations/org-1/membership");
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ id: "m1", role: "member" });
    });

    it("returns a synthetic admin membership for a super admin", async () => {
      mockSession({ id: "admin-1", role: "admin" });
      seedDb();

      const res = await app.request("/organizations/org-1/membership");
      expect(await res.json()).toEqual({ role: "admin", isSuperAdmin: true });
    });
  });

  describe("PUT /organizations/:orgId", () => {
    const seed = (role: "admin" | "member") =>
      seedDb({
        organization: [
          { id: "org-1", name: "Org 1" },
          { id: "org-2", name: "Org 2" },
        ],
        organization_member: [
          { id: "m1", userId: "user-1", organizationId: "org-1", role },
        ],
      });

    const put = (body: unknown) =>
      app.request("/organizations/org-1", {
        method: "PUT",
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
      });

    it("returns 403 for a non-admin member", async () => {
      mockSession({ id: "user-1", role: "user" });
      const fake = seed("member");

      const res = await put({ name: "Renamed" });

      expect(res.status).toBe(403);
      expect(fake.tables.organization.map((o) => o.name)).toEqual([
        "Org 1",
        "Org 2",
      ]);
    });

    it("should accept and persist identityContext for an admin", async () => {
      mockSession({ id: "user-1", role: "user" });
      const fake = seed("admin");

      const res = await put({
        name: "Org 1",
        identityContext: "We are Acme.",
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        id: "org-1",
        name: "Org 1",
        identityContext: "We are Acme.",
      });
      // Guards the update's `id` filter: `org-2` is left as it was.
      expect(fake.tables.organization).toEqual([
        expect.objectContaining({
          id: "org-1",
          identityContext: "We are Acme.",
        }),
        { id: "org-2", name: "Org 2" },
      ]);
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
          { id: "ws-1", organizationId: "org-1", ownerId: "owner-1" },
          { id: "ws-2", organizationId: "org-1", ownerId: "owner-2" },
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

    describe("Sandbox teardown", () => {
      const BACKEND = "test-org-teardown";
      const destroy = vi.fn<SandboxBackend["destroy"]>();

      beforeEach(() => {
        clearSandboxBackends();
        registerSandboxBackend({
          backend: BACKEND,
          name: "Test",
          configSchema: z.object({}),
          credentialsSchema: z.object({}),
          create: () => ({ destroy }) as unknown as SandboxBackend,
        });
      });

      const sandbox = (id: string, workspaceId: string, backend = BACKEND) => ({
        id,
        workspaceId,
        backend,
        config: {},
        credentials: {},
      });

      const seedWithSandboxes = (sandboxes: ReturnType<typeof sandbox>[]) => {
        const fake = seed();
        fake.tables.sandbox = sandboxes;
        fake.tables.sandbox_teardown_failure = [];
        return fake;
      };

      it("destroys every Workspace's Sandboxes, with that Workspace's context, before the Organization row is deleted", async () => {
        mockSession({ id: "admin-1", role: "user" });
        const fake = seedWithSandboxes([
          sandbox("sb-1", "ws-1"),
          sandbox("sb-2", "ws-2"),
          // Another Organization's Sandbox: must be left alone.
          sandbox("sb-3", "ws-3"),
        ]);
        const orgPresent: boolean[] = [];
        destroy.mockImplementation(() => {
          orgPresent.push(
            fake.tables.organization.some((row) => row.id === "org-1"),
          );
          return Promise.resolve();
        });

        const res = await app.request("/organizations/org-1", {
          method: "DELETE",
        });

        expect(res.status).toBe(200);
        expect(destroy.mock.calls.map(([ctx]) => ctx)).toEqual(
          expect.arrayContaining([
            { orgId: "org-1", workspaceId: "ws-1", userId: "owner-1" },
            { orgId: "org-1", workspaceId: "ws-2", userId: "owner-2" },
          ]),
        );
        expect(destroy).toHaveBeenCalledTimes(2);
        expect(orgPresent).toEqual([true, true]);
        expect(fake.tables.sandbox_teardown_failure).toEqual([]);
      });

      it("still deletes the Organization, and records a ledger row, when a teardown fails", async () => {
        mockSession({ id: "admin-1", role: "user" });
        const fake = seedWithSandboxes([
          sandbox("sb-1", "ws-1"),
          sandbox("sb-2", "ws-2", "unregistered"),
        ]);
        destroy.mockRejectedValue(new Error("container already gone"));

        const res = await app.request("/organizations/org-1", {
          method: "DELETE",
        });

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ message: "Organization deleted" });
        expect(fake.tables.organization.map((row) => row.id)).toEqual([
          "org-10",
        ]);
        expect(fake.tables.sandbox_teardown_failure).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              workspaceId: "ws-1",
              backend: BACKEND,
              error: "container already gone",
            }),
            expect.objectContaining({
              workspaceId: "ws-2",
              backend: "unregistered",
            }),
          ]),
        );
        expect(fake.tables.sandbox_teardown_failure).toHaveLength(2);
      });

      it("deletes an Organization with no Workspaces without touching any Sandbox", async () => {
        mockSession({ id: "admin-1", role: "user" });
        const fake = seedWithSandboxes([sandbox("sb-3", "ws-3")]);
        fake.tables.workspace = fake.tables.workspace.filter(
          (row) => row.organizationId !== "org-1",
        );

        const res = await app.request("/organizations/org-1", {
          method: "DELETE",
        });

        expect(res.status).toBe(200);
        expect(destroy).not.toHaveBeenCalled();
        expect(fake.tables.sandbox_teardown_failure).toEqual([]);
      });
    });

    it("leaves storage untouched when the DB delete fails", async () => {
      mockSession({ id: "admin-1", role: "user" });
      const fake = seed();
      await putStoredFiles([...inside, ...avatars]);
      vi.spyOn(
        fake.handle as { transaction: () => Promise<never> },
        "transaction",
      ).mockRejectedValue(dbError("08006", "db down"));

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
