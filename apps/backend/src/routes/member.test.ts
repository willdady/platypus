import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  mockDb,
  mockSession,
  resetMockDb,
  seedDb,
  type FakeDb,
  type Row,
} from "../test-utils.ts";
import app from "../server.ts";

describe("Member Routes", () => {
  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
  });

  const orgId = "org-1";
  const baseUrl = `/organizations/${orgId}/members`;

  const membership = (
    id: string,
    userId: string,
    role: "admin" | "member",
    organizationId = orgId,
  ): Row => ({ id, userId, organizationId, role });

  /**
   * The caller (`admin-1`) is an admin of `org-1`; `extra` adds the members a
   * test acts on. Another org's admin (`m-other`) is always present so a route
   * that dropped its `organizationId` scope finds a row it must not.
   */
  const world = (extra: Row[] = []): FakeDb =>
    seedDb({
      organization_member: [
        membership("m-self", "admin-1", "admin"),
        membership("m-other", "u-other", "admin", "org-2"),
        ...extra,
      ],
    });

  const send = (method: "PATCH" | "DELETE", memberId: string, body?: unknown) =>
    app.request(`${baseUrl}/${memberId}`, {
      method,
      ...(body !== undefined && {
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
      }),
    });

  const roleOf = (fake: FakeDb, id: string) =>
    fake.tables.organization_member.find((m) => m.id === id)?.role;

  describe("GET /", () => {
    it("should list organization members", async () => {
      // The list projects a nested `user` object, which the seeded fake cannot
      // compute, so this one stays on the chainable mock.
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]); // requireOrgAccess

      const mockMembers = [
        {
          id: "m1",
          userId: "u1",
          user: { id: "u1", name: "User 1", email: "u1@ex.com", role: "user" },
        },
        {
          id: "m2",
          userId: "u2",
          user: { id: "u2", name: "User 2", email: "u2@ex.com", role: "admin" },
        },
      ];

      mockDb.where
        .mockReturnValueOnce(mockDb) // requireOrgAccess
        .mockResolvedValueOnce(mockMembers); // list members

      const res = await app.request(baseUrl);
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        results: { id: string; isSuperAdmin: boolean }[];
      };
      expect(json.results.map((m) => [m.id, m.isSuperAdmin])).toEqual([
        ["m1", false],
        ["m2", true],
      ]);
    });

    it("returns 403 for a non-admin member", async () => {
      mockSession({ id: "u1", role: "user" });
      world([membership("m1", "u1", "member")]);

      const res = await app.request(baseUrl);
      expect(res.status).toBe(403);
    });
  });

  describe("GET /:memberId", () => {
    it("returns 404 when the member is not in this organization", async () => {
      mockSession({ id: "admin-1", role: "user" });
      mockDb.limit
        .mockResolvedValueOnce([{ role: "admin" }]) // requireOrgAccess
        .mockResolvedValueOnce([]); // member lookup

      const res = await app.request(`${baseUrl}/m-other`);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Member not found" });
    });

    it("returns the member with its super-admin flag", async () => {
      mockSession({ id: "admin-1", role: "user" });
      mockDb.limit
        .mockResolvedValueOnce([{ role: "admin" }]) // requireOrgAccess
        .mockResolvedValueOnce([
          { id: "m1", userId: "u1", user: { id: "u1", role: "admin" } },
        ]);

      const res = await app.request(`${baseUrl}/m1`);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ id: "m1", isSuperAdmin: true });
    });
  });

  describe("PATCH /:memberId", () => {
    beforeEach(() => mockSession({ id: "admin-1", role: "user" }));

    it("should update member role", async () => {
      const fake = world([membership("m1", "u1", "member")]);

      const res = await send("PATCH", "m1", { role: "admin" });

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ id: "m1", role: "admin" });
      expect(roleOf(fake, "m1")).toBe("admin");
    });

    it("demotes an admin while another admin remains", async () => {
      const fake = world([membership("m1", "u1", "admin")]);

      const res = await send("PATCH", "m1", { role: "member" });

      expect(res.status).toBe(200);
      expect(roleOf(fake, "m1")).toBe("member");
    });

    it("returns 404 for a member of another organization", async () => {
      const fake = world();

      const res = await send("PATCH", "m-other", { role: "member" });

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Member not found" });
      expect(roleOf(fake, "m-other")).toBe("admin");
    });

    it("should return 400 if demoting self", async () => {
      const fake = world([membership("m1", "u1", "admin")]);

      const res = await send("PATCH", "m-self", { role: "member" });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: "You cannot demote yourself from admin",
      });
      expect(roleOf(fake, "m-self")).toBe("admin");
    });

    it("refuses to demote the last admin of the organization", async () => {
      // A super admin is not a member, so the only admin row is `m1`; the other
      // org's admin must not count towards this org's total.
      mockSession({ id: "super-1", role: "admin" });
      const fake = seedDb({
        organization_member: [
          membership("m1", "u1", "admin"),
          membership("m-other", "u-other", "admin", "org-2"),
        ],
      });

      const res = await send("PATCH", "m1", { role: "member" });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: "Cannot demote the last organization admin",
      });
      expect(roleOf(fake, "m1")).toBe("admin");
    });

    it("returns 403 for a non-admin member", async () => {
      mockSession({ id: "u1", role: "user" });
      const fake = world([
        membership("m1", "u1", "member"),
        membership("m2", "u2", "member"),
      ]);

      const res = await send("PATCH", "m2", { role: "admin" });

      expect(res.status).toBe(403);
      expect(roleOf(fake, "m2")).toBe("member");
    });
  });

  describe("DELETE /:memberId", () => {
    beforeEach(() => mockSession({ id: "admin-1", role: "user" }));

    const ids = (fake: FakeDb) =>
      fake.tables.organization_member.map((m) => m.id);

    it("removes a member from the organization", async () => {
      const fake = world([membership("m1", "u1", "member")]);

      const res = await send("DELETE", "m1");

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        message: "Member removed from organization",
      });
      expect(ids(fake)).toEqual(["m-self", "m-other"]);
    });

    it("removes an admin while another admin remains", async () => {
      const fake = world([membership("m1", "u1", "admin")]);

      const res = await send("DELETE", "m1");

      expect(res.status).toBe(200);
      expect(ids(fake)).not.toContain("m1");
    });

    it("returns 404 for a member of another organization", async () => {
      const fake = world();

      const res = await send("DELETE", "m-other");

      expect(res.status).toBe(404);
      expect(ids(fake)).toContain("m-other");
    });

    it("refuses to remove yourself", async () => {
      const fake = world([membership("m1", "u1", "admin")]);

      const res = await send("DELETE", "m-self");

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: "You cannot remove yourself from the organization",
      });
      expect(ids(fake)).toContain("m-self");
    });

    it("refuses to remove the last admin of the organization", async () => {
      mockSession({ id: "super-1", role: "admin" });
      const fake = seedDb({
        organization_member: [
          membership("m1", "u1", "admin"),
          membership("m-other", "u-other", "admin", "org-2"),
        ],
      });

      const res = await send("DELETE", "m1");

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: "Cannot remove the last organization admin",
      });
      expect(ids(fake)).toContain("m1");
    });

    it("returns 403 for a non-admin member", async () => {
      mockSession({ id: "u1", role: "user" });
      const fake = world([
        membership("m1", "u1", "member"),
        membership("m2", "u2", "member"),
      ]);

      const res = await send("DELETE", "m2");

      expect(res.status).toBe(403);
      expect(ids(fake)).toContain("m2");
    });
  });
});
