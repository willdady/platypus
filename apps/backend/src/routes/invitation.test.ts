import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  dbError,
  mockSession,
  resetMockDb,
  seedDb,
  type FakeDb,
  type Row,
  type Store,
} from "../test-utils.ts";
import type { FakeDbOptions } from "../fake-db.ts";
import app from "../server.ts";
import { logger } from "../logger.ts";

describe("Invitation Routes", () => {
  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const orgId = "org-1";
  const baseUrl = `/organizations/${orgId}/invitations`;
  const DAY = 24 * 60 * 60 * 1000;

  const post = (body: unknown) =>
    app.request(baseUrl, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    });

  const adminSession = () =>
    mockSession({ id: "user-1", email: "admin@example.com", role: "user" });

  const membership = (role: "admin" | "member" = "admin"): Row => ({
    id: "m1",
    userId: "user-1",
    organizationId: orgId,
    role,
  });

  const world = (
    role: "admin" | "member" = "admin",
    rows: Store = {},
    db: FakeDbOptions = {},
  ): FakeDb => seedDb({ organization_member: [membership(role)], ...rows }, db);

  const inserts = (fake: FakeDb) =>
    fake.queries.filter((query) => query.kind === "insert");

  describe("POST /", () => {
    it("should create invitation if org admin", async () => {
      adminSession();
      const fake = world();

      const res = await post({ email: "user@example.com" });

      expect(res.status).toBe(201);
      const created = fake.tables.invitation.at(-1)!;
      expect(created).toMatchObject({
        email: "user@example.com",
        organizationId: orgId,
        status: "pending",
      });
      expect(await res.json()).toEqual({
        ...created,
        expiresAt: (created.expiresAt as Date).toISOString(),
        blueprintIds: [],
      });
    });

    it("normalizes a mixed-case invitation email before persistence", async () => {
      adminSession();
      const fake = world();

      const res = await post({ email: "User@Example.COM" });

      expect(res.status).toBe(201);
      expect(fake.tables.invitation.at(-1)).toMatchObject({
        email: "user@example.com",
      });
      expect(await res.json()).toMatchObject({ email: "user@example.com" });
    });

    it("persists an ordered set of blueprints", async () => {
      adminSession();
      const fake = world("admin", {
        blueprint: [
          { id: "bp-1", organizationId: orgId, name: "BP 1" },
          { id: "bp-2", organizationId: orgId, name: "BP 2" },
        ],
      });

      const res = await post({
        email: "user@example.com",
        blueprintIds: ["bp-1", "bp-2", "bp-1"],
      });

      expect(res.status).toBe(201);
      expect(
        ((await res.json()) as { blueprintIds: string[] }).blueprintIds,
      ).toEqual(["bp-1", "bp-2"]);

      expect(fake.tables.invitation_blueprint).toEqual([
        expect.objectContaining({ blueprintId: "bp-1", position: 0 }),
        expect.objectContaining({ blueprintId: "bp-2", position: 1 }),
      ]);
    });

    it("404s when a blueprint is not in this organization", async () => {
      adminSession();
      const fake = world("admin", {
        blueprint: [
          { id: "bp-1", organizationId: orgId, name: "BP 1" },
          { id: "bp-2", organizationId: "org-2", name: "BP 2" },
        ],
      });

      const res = await post({
        email: "user@example.com",
        blueprintIds: ["bp-1", "bp-2"],
      });

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({
        error: "Blueprints not found in this organization: bp-2",
      });
      expect(inserts(fake)).toEqual([]);
    });

    it("should persist an optional workspaceName", async () => {
      adminSession();
      const fake = world();

      const res = await post({
        email: "user@example.com",
        workspaceName: "Contractor Sandbox",
      });

      expect(res.status).toBe(201);
      expect(fake.tables.invitation.at(-1)).toMatchObject({
        email: "user@example.com",
        workspaceName: "Contractor Sandbox",
      });
    });

    it("409s with the central error envelope on a duplicate org+email invitation", async () => {
      adminSession();
      const fake = world(
        "admin",
        {
          invitation: [
            {
              id: "inv-old",
              email: "user@example.com",
              organizationId: orgId,
              invitedBy: "user-1",
              token: "old-token",
              status: "pending",
              expiresAt: new Date(Date.now() + DAY),
            },
          ],
        },
        {
          unique: {
            invitation: [
              {
                name: "unique_invitation_org_email",
                columns: ["organizationId", "email"],
                where: (row) => row.status === "pending",
              },
            ],
          },
        },
      );

      const res = await post({ email: "user@example.com" });

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error:
          "A pending invitation already exists for this user and organization",
        files: undefined,
      });
      expect(fake.tables.invitation).toHaveLength(1);
    });

    it("logs an unexpected failure once, as the 500 it answers", async () => {
      adminSession();
      world(
        "admin",
        {},
        {
          onInsert: (table) => {
            if (table === "invitation")
              throw dbError("08006", "connection reset");
          },
        },
      );
      const logError = vi.spyOn(logger, "error");

      const res = await post({ email: "user@example.com" });

      expect(res.status).toBe(500);
      expect(logError).toHaveBeenCalledTimes(1);
    });

    describe("re-inviting an address with an earlier invitation", () => {
      const seedWithInvitation = (
        prior: { status: string; expiresAt: Date },
        { inviteeIsMember = false } = {},
      ) =>
        seedDb(
          {
            user: [
              { id: "user-1", email: "test@example.com" },
              { id: "user-2", email: "user@example.com" },
            ],
            organization_member: [
              {
                id: "m1",
                userId: "user-1",
                organizationId: orgId,
                role: "admin",
              },
              ...(inviteeIsMember
                ? [
                    {
                      id: "m2",
                      userId: "user-2",
                      organizationId: orgId,
                      role: "member",
                    },
                  ]
                : []),
            ],
            invitation: [
              {
                id: "inv-old",
                email: "user@example.com",
                organizationId: orgId,
                invitedBy: "user-1",
                token: "old-token",
                ...prior,
              },
            ],
          },
          {
            unique: {
              invitation: [
                {
                  name: "unique_invitation_org_email",
                  columns: ["organizationId", "email"],
                  where: (row) => row.status === "pending",
                },
              ],
            },
          },
        );

      const reinvite = () => post({ email: "user@example.com" });

      const past = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const future = new Date(Date.now() + 24 * 60 * 60 * 1000);

      it.each(["declined", "accepted", "expired"])(
        "creates a new invitation when the earlier one is %s",
        async (status) => {
          mockSession();
          const fake = seedWithInvitation({ status, expiresAt: past });

          const res = await reinvite();

          expect(res.status).toBe(201);
          expect(fake.tables.invitation).toHaveLength(2);
          expect(fake.tables.invitation[1]).toMatchObject({
            email: "user@example.com",
            status: "pending",
          });
        },
      );

      it("expires a lapsed pending invitation and creates a new one", async () => {
        mockSession();
        const fake = seedWithInvitation({ status: "pending", expiresAt: past });

        const res = await reinvite();

        expect(res.status).toBe(201);
        expect(fake.tables.invitation).toEqual([
          expect.objectContaining({ id: "inv-old", status: "expired" }),
          expect.objectContaining({ status: "pending" }),
        ]);
      });

      it("409s when the address already belongs to a member", async () => {
        mockSession();
        const fake = seedWithInvitation(
          { status: "accepted", expiresAt: past },
          { inviteeIsMember: true },
        );

        const res = await reinvite();

        expect(res.status).toBe(409);
        expect(await res.json()).toMatchObject({
          error: "This user is already a member of the organization",
        });
        expect(fake.tables.invitation).toHaveLength(1);
      });

      it("409s while the earlier invitation is still pending and live", async () => {
        mockSession();
        const fake = seedWithInvitation({
          status: "pending",
          expiresAt: future,
        });

        const res = await reinvite();

        expect(res.status).toBe(409);
        expect(fake.tables.invitation).toEqual([
          expect.objectContaining({ id: "inv-old", status: "pending" }),
        ]);
      });
    });

    it("mints a token when creating an invitation", async () => {
      adminSession();
      const fake = world();

      const res = await post({ email: "user@example.com" });

      expect(res.status).toBe(201);
      const inserted = fake.tables.invitation.at(-1)!;
      expect(typeof inserted.token).toBe("string");
      expect(inserted.token).toHaveLength(21);
    });

    it("should return 400 if inviting self", async () => {
      adminSession();
      const fake = world();

      const res = await post({ email: "Admin@Example.COM" });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: "You cannot invite yourself",
      });
      expect(inserts(fake)).toEqual([]);
    });

    it("returns 403 for a non-admin member", async () => {
      mockSession();
      const fake = world("member");

      const res = await post({ email: "user@example.com" });

      expect(res.status).toBe(403);
      expect(inserts(fake)).toEqual([]);
    });
  });

  describe("GET /", () => {
    it("should list invitations, each with its ordered blueprint set", async () => {
      mockSession();
      world("admin", {
        invitation: [
          {
            id: "inv-1",
            email: "a@example.com",
            organizationId: orgId,
            workspaceName: "WS 1",
          },
          {
            id: "inv-2",
            email: "b@example.com",
            organizationId: orgId,
            workspaceName: "WS 2",
          },
          {
            id: "inv-other",
            email: "c@example.com",
            organizationId: "org-2",
            workspaceName: "WS 3",
          },
        ],
        invitation_blueprint: [
          {
            id: "ib-1",
            invitationId: "inv-1",
            blueprintId: "bp-1",
            position: 0,
          },
          {
            id: "ib-2",
            invitationId: "inv-1",
            blueprintId: "bp-2",
            position: 1,
          },
        ],
      });

      const res = await app.request(baseUrl);
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        results: { id: string; blueprintIds: string[] }[];
      };
      expect(json.results.map((r) => r.id)).toEqual(["inv-1", "inv-2"]);
      expect(json.results[0].blueprintIds).toEqual(["bp-1", "bp-2"]);
      expect(json.results[1].blueprintIds).toEqual([]);
    });
  });

  describe("DELETE /:invitationId", () => {
    const seedInvites = (role: "admin" | "member" = "admin") =>
      seedDb({
        organization_member: [
          { id: "m1", userId: "user-1", organizationId: orgId, role },
        ],
        invitation: [
          { id: "inv-1", organizationId: orgId },
          { id: "inv-other", organizationId: "org-2" },
        ],
      });

    const remove = (id: string) =>
      app.request(`${baseUrl}/${id}`, { method: "DELETE" });

    const ids = (fake: ReturnType<typeof seedInvites>) =>
      fake.tables.invitation.map((i) => i.id);

    it("should delete invitation", async () => {
      mockSession();
      const fake = seedInvites();

      const res = await remove("inv-1");

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ message: "Invitation deleted" });
      expect(ids(fake)).toEqual(["inv-other"]);
    });

    it("returns 404 for another organization's invitation", async () => {
      mockSession();
      const fake = seedInvites();

      const res = await remove("inv-other");

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Invitation not found" });
      expect(ids(fake)).toEqual(["inv-1", "inv-other"]);
    });

    it("returns 403 for a non-admin member", async () => {
      mockSession();
      const fake = seedInvites("member");

      const res = await remove("inv-1");

      expect(res.status).toBe(403);
      expect(ids(fake)).toEqual(["inv-1", "inv-other"]);
    });
  });
});
