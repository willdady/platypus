import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  mockSession,
  resetMockDb,
  seedDb,
  type FakeDb,
  type Row,
} from "../test-utils.ts";
import app from "../server.ts";

describe("User Invitation Routes", () => {
  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
  });

  const baseUrl = "/users/me/invitations";

  const DAY = 24 * 60 * 60 * 1000;

  const invitee = {
    id: "u1",
    email: "user@example.com",
    name: "Jane",
    role: "user",
    emailVerified: true,
  };

  const invite = (over: Row = {}): Row => ({
    organizationId: "org-1",
    invitedBy: "admin-1",
    email: "user@example.com",
    status: "pending",
    expiresAt: new Date(Date.now() + 7 * DAY),
    ...over,
  });

  const seedInvitations = (): FakeDb =>
    seedDb({
      organization: [{ id: "org-1", name: "Org 1" }],
      user: [{ id: "admin-1", name: "Admin" }],
      invitation: [
        invite({ id: "inv-live" }),
        invite({ id: "inv-expired", expiresAt: new Date(Date.now() - DAY) }),
        invite({ id: "inv-declined", status: "declined" }),
        invite({ id: "inv-other", email: "someone@example.com" }),
      ],
    });

  const invitationRow = (over: Row = {}): Row => ({
    id: "inv-1",
    email: "user@example.com",
    status: "pending",
    expiresAt: new Date(Date.now() + 7 * DAY),
    organizationId: "org-1",
    workspaceName: null,
    ...over,
  });

  const invitationWorld = (over: Row = {}): FakeDb =>
    seedDb({ invitation: [invitationRow(over)] });

  const roundTripWorld = (): FakeDb =>
    seedDb({
      organization: [{ id: "org-1", name: "Org 1" }],
      user: [{ id: "admin-1", name: "Admin" }],
      organization_member: [
        { id: "m1", userId: "admin-1", organizationId: "org-1", role: "admin" },
      ],
    });

  describe("GET /", () => {
    it("lists only the user's live pending invitations", async () => {
      mockSession(invitee);
      seedInvitations();

      const res = await app.request(baseUrl);

      expect(res.status).toBe(200);
      const body = (await res.json()) as { results: Row[] };
      expect(body.results).toEqual([
        expect.objectContaining({
          id: "inv-live",
          organizationName: "Org 1",
          invitedByName: "Admin",
        }),
      ]);
    });

    it("still lists an invitation whose inviter's account was deleted", async () => {
      mockSession(invitee);
      seedDb({
        organization: [{ id: "org-1", name: "Org 1" }],
        invitation: [
          {
            id: "inv-orphan",
            organizationId: "org-1",
            invitedBy: null,
            email: "user@example.com",
            status: "pending",
            expiresAt: new Date(Date.now() + 7 * DAY),
          },
        ],
      });

      const res = await app.request(baseUrl);

      expect(res.status).toBe(200);
      const body = (await res.json()) as { results: Row[] };
      expect(body.results).toEqual([
        expect.objectContaining({ id: "inv-orphan", invitedBy: null }),
      ]);
      expect(body.results[0].invitedByName ?? null).toBeNull();
    });
  });

  describe("an account whose email is unverified", () => {
    const unverified = () =>
      mockSession({
        id: "u1",
        email: "user@example.com",
        role: "user",
        emailVerified: false,
      });

    it("lists no invitations", async () => {
      unverified();
      seedInvitations();

      const res = await app.request(baseUrl);

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ results: [] });
    });

    it.each(["accept", "decline"])(
      "cannot %s an invitation addressed to it",
      async (action) => {
        unverified();
        const fake = seedInvitations();

        const res = await app.request(`${baseUrl}/inv-live/${action}`, {
          method: "POST",
        });

        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({
          error: "Invitation not found or already processed",
        });
        expect(
          fake.tables.invitation.find((i) => i.id === "inv-live")?.status,
        ).toBe("pending");
        expect(fake.queries).toEqual([]);
      },
    );
  });

  describe("POST /:invitationId/accept", () => {
    it("should accept invitation and provision a workspace with the invite name", async () => {
      mockSession(invitee);
      const fake = invitationWorld({ workspaceName: "Contractor Sandbox" });

      const res = await app.request(`${baseUrl}/inv-1/accept`, {
        method: "POST",
      });

      expect(res.status).toBe(200);
      const provisioned = fake.tables.workspace.at(-1)!;
      expect(provisioned).toMatchObject({
        organizationId: "org-1",
        ownerId: "u1",
        name: "Contractor Sandbox",
      });
      expect(fake.tables.organization_member).toEqual([
        expect.objectContaining({
          organizationId: "org-1",
          userId: "u1",
          role: "member",
        }),
      ]);
      expect(fake.tables.invitation[0].status).toBe("accepted");

      expect(await res.json()).toEqual({
        message: "Invitation accepted",
        organizationId: "org-1",
        workspaceId: provisioned.id,
      });
    });

    it("should default the workspace name to the member's name", async () => {
      mockSession(invitee);
      const fake = invitationWorld();

      const res = await app.request(`${baseUrl}/inv-1/accept`, {
        method: "POST",
      });

      expect(res.status).toBe(200);
      const provisioned = fake.tables.workspace.at(-1)!;
      expect(provisioned).toMatchObject({
        ownerId: "u1",
        name: "Jane's Workspace",
      });
    });

    it("uses a bare apostrophe for names ending in s", async () => {
      mockSession({ ...invitee, name: "James" });
      const fake = invitationWorld();

      const res = await app.request(`${baseUrl}/inv-1/accept`, {
        method: "POST",
      });

      expect(res.status).toBe(200);
      expect(fake.tables.workspace.at(-1)).toMatchObject({
        name: "James' Workspace",
      });
    });

    it("clamps a long member name to the workspace name limit", async () => {
      mockSession({ ...invitee, name: "Maximilian Alexander Bartholomew" });
      const fake = invitationWorld();

      const res = await app.request(`${baseUrl}/inv-1/accept`, {
        method: "POST",
      });

      expect(res.status).toBe(200);
      const provisioned = fake.tables.workspace.at(-1)!;
      const name = provisioned.name as string;
      expect(name.length).toBeLessThanOrEqual(30);
      expect(name.endsWith(" Workspace")).toBe(true);
    });

    it("applies the invitation's ordered blueprints (Tier 1 union, Tier 2 last-write-wins)", async () => {
      mockSession(invitee);
      const fake = seedDb({
        invitation: [invitationRow({ workspaceName: "Provisioned" })],
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
        blueprint: [
          {
            id: "bp-1",
            organizationId: "org-1",
            taskModelProviderId: "prov-A",
            memoryExtractionProviderId: null,
            memoryEmbeddingProviderId: null,
            context: "ctx-1",
          },
          {
            id: "bp-2",
            organizationId: "org-1",
            taskModelProviderId: "prov-B",
            memoryExtractionProviderId: null,
            memoryEmbeddingProviderId: null,
            context: null,
          },
        ],
        blueprint_item: [
          {
            id: "bi-1",
            blueprintId: "bp-1",
            resourceType: "agent",
            resourceId: "agent-1",
          },
          {
            id: "bi-2",
            blueprintId: "bp-2",
            resourceType: "agent",
            resourceId: "agent-1",
          },
          {
            id: "bi-3",
            blueprintId: "bp-2",
            resourceType: "skill",
            resourceId: "skill-1",
          },
        ],
      });

      const res = await app.request(`${baseUrl}/inv-1/accept`, {
        method: "POST",
      });

      expect(res.status).toBe(200);

      const provisioned = fake.tables.workspace.at(-1)!;
      const attached = fake.tables.attachment.filter(
        (a) => a.workspaceId === provisioned.id,
      );
      expect(attached).toHaveLength(2);
      expect(attached.map((a) => a.resourceId).sort()).toEqual([
        "agent-1",
        "skill-1",
      ]);

      expect(provisioned).toMatchObject({
        taskModelProviderId: "prov-B",
        context: "ctx-1",
      });
    });

    it("provisions an empty workspace and attaches nothing for a blueprint-less invite", async () => {
      mockSession(invitee);
      const fake = invitationWorld();

      const res = await app.request(`${baseUrl}/inv-1/accept`, {
        method: "POST",
      });

      expect(res.status).toBe(200);
      expect(
        fake.queries.filter(
          (q) => q.kind === "insert" && q.table === "attachment",
        ),
      ).toEqual([]);
    });

    it("should return 410 if invitation expired", async () => {
      mockSession(invitee);
      const fake = invitationWorld({
        expiresAt: new Date(Date.now() - DAY),
      });

      const res = await app.request(`${baseUrl}/inv-1/accept`, {
        method: "POST",
      });

      expect(res.status).toBe(410);
      expect(await res.json()).toEqual({ error: "Invitation has expired" });
      expect(fake.tables.invitation[0].status).toBe("expired");
    });
  });

  describe("POST /:invitationId/decline", () => {
    const decline = (id: string) =>
      app.request(`${baseUrl}/${id}/decline`, { method: "POST" });

    it("should decline invitation", async () => {
      mockSession(invitee);
      const fake = seedInvitations();

      const res = await decline("inv-live");

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ message: "Invitation declined" });
      expect(
        fake.tables.invitation.find((i) => i.id === "inv-live")?.status,
      ).toBe("declined");
    });

    it.each([
      ["someone else's invitation", "inv-other", "pending"],
      ["an already-processed invitation", "inv-declined", "declined"],
    ])("returns 404 for %s", async (_label, id, status) => {
      mockSession(invitee);
      const fake = seedInvitations();

      const res = await decline(id);

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({
        error: "Invitation not found or already processed",
      });
      expect(fake.tables.invitation.find((i) => i.id === id)?.status).toBe(
        status,
      );
    });
  });

  describe("mixed-case invitation round trip", () => {
    const createInvitationAs = async (
      fake: FakeDb,
      typedEmail: string,
      workspaceName: string,
    ): Promise<Row> => {
      mockSession({
        id: "admin-1",
        email: "admin@example.com",
        role: "user",
        emailVerified: true,
      });

      const res = await app.request("/organizations/org-1/invitations", {
        method: "POST",
        body: JSON.stringify({ email: typedEmail, workspaceName }),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(201);

      const row = fake.tables.invitation.at(-1);
      expect(row).toBeDefined();
      return row!;
    };

    it("is listed, accepted and declined by the lower-case account", async () => {
      const fake = roundTripWorld();
      const created = await createInvitationAs(
        fake,
        "User@Example.COM",
        "Contractor Sandbox",
      );
      expect(created.email).toBe("user@example.com");

      mockSession(invitee);
      const listRes = await app.request(baseUrl);
      expect(listRes.status).toBe(200);
      expect(await listRes.json()).toEqual({
        results: [
          {
            id: created.id,
            email: "user@example.com",
            organizationId: "org-1",
            invitedBy: "admin-1",
            status: "pending",
            workspaceName: "Contractor Sandbox",
            expiresAt: (created.expiresAt as Date).toISOString(),
            organizationName: "Org 1",
            invitedByName: "Admin",
          },
        ],
      });

      mockSession(invitee);
      const acceptRes = await app.request(
        `${baseUrl}/${String(created.id)}/accept`,
        { method: "POST" },
      );
      expect(acceptRes.status).toBe(200);

      const provisioned = fake.tables.workspace.at(-1)!;
      expect(await acceptRes.json()).toEqual({
        message: "Invitation accepted",
        organizationId: "org-1",
        workspaceId: provisioned.id,
      });
      expect(provisioned).toMatchObject({
        organizationId: "org-1",
        ownerId: "u1",
        name: "Contractor Sandbox",
      });

      fake.tables.invitation.push({
        id: "inv-2",
        email: "user@example.com",
        organizationId: "org-1",
        invitedBy: "admin-1",
        status: "pending",
        workspaceName: "Second",
        token: "tok-2",
        expiresAt: new Date(Date.now() + 7 * DAY),
      });

      mockSession(invitee);
      const declineRes = await app.request(`${baseUrl}/inv-2/decline`, {
        method: "POST",
      });
      expect(declineRes.status).toBe(200);
      expect(await declineRes.json()).toEqual({
        message: "Invitation declined",
      });
      expect(fake.tables.invitation.find((i) => i.id === "inv-2")?.status).toBe(
        "declined",
      );
    });
  });
});
