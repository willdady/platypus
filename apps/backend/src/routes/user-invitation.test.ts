import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  mockDb,
  mockSession,
  resetMockDb,
  seedDb,
  type Row,
} from "../test-utils.ts";
import app from "../server.ts";

const resetChain = () => {
  resetMockDb();
  vi.clearAllMocks();
  mockDb.where.mockReturnValue(mockDb);
  mockDb.innerJoin.mockReturnValue(mockDb);
  mockDb.for.mockImplementation(((strength: string) =>
    strength === "share"
      ? Promise.resolve([{ id: "member-1" }])
      : mockDb) as never);
};

describe("User Invitation Routes", () => {
  beforeEach(() => resetChain());

  const baseUrl = "/users/me/invitations";

  const DAY = 24 * 60 * 60 * 1000;

  const seedInvitations = () => {
    const invite = (over: Row): Row => ({
      organizationId: "org-1",
      invitedBy: "admin-1",
      email: "user@example.com",
      status: "pending",
      expiresAt: new Date(Date.now() + 7 * DAY),
      ...over,
    });
    return seedDb({
      organization: [{ id: "org-1", name: "Org 1" }],
      user: [{ id: "admin-1", name: "Admin" }],
      invitation: [
        invite({ id: "inv-live" }),
        invite({ id: "inv-expired", expiresAt: new Date(Date.now() - DAY) }),
        invite({ id: "inv-declined", status: "declined" }),
        invite({ id: "inv-other", email: "someone@example.com" }),
      ],
    });
  };

  describe("GET /", () => {
    it("lists only the user's live pending invitations", async () => {
      mockSession({
        id: "u1",
        email: "user@example.com",
        role: "user",
        emailVerified: true,
      });
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
      mockSession({
        id: "u1",
        email: "user@example.com",
        role: "user",
        emailVerified: true,
      });
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
        expect(mockDb.transaction).not.toHaveBeenCalled();
      },
    );
  });

  describe("POST /:invitationId/accept", () => {
    it("should accept invitation and provision a workspace with the invite name", async () => {
      mockSession({
        id: "u1",
        email: "user@example.com",
        name: "Jane",
        role: "user",
        emailVerified: true,
      });

      const futureDate = new Date();
      futureDate.setDate(futureDate.getDate() + 7);

      const mockInvitation = {
        id: "inv-1",
        email: "user@example.com",
        status: "pending",
        expiresAt: futureDate.toISOString(),
        organizationId: "org-1",
        workspaceName: "Contractor Sandbox",
      };

      mockDb.limit.mockResolvedValueOnce([mockInvitation]);

      mockDb.orderBy.mockResolvedValueOnce([]);

      const res = await app.request(`${baseUrl}/inv-1/accept`, {
        method: "POST",
      });

      expect(res.status).toBe(200);
      expect(mockDb.transaction).toHaveBeenCalled();

      const insertedValues = mockDb.values.mock.calls.map(
        (c) => c[0] as Record<string, unknown>,
      );
      const provisioned = insertedValues.find((v) => v.name);
      expect(provisioned).toMatchObject({
        organizationId: "org-1",
        ownerId: "u1",
        name: "Contractor Sandbox",
      });

      expect(await res.json()).toEqual({
        message: "Invitation accepted",
        organizationId: "org-1",
        workspaceId: provisioned!.id,
      });
    });

    it("should default the workspace name to the member's name", async () => {
      mockSession({
        id: "u1",
        email: "user@example.com",
        name: "Jane",
        role: "user",
        emailVerified: true,
      });

      const futureDate = new Date();
      futureDate.setDate(futureDate.getDate() + 7);

      mockDb.limit.mockResolvedValueOnce([
        {
          id: "inv-1",
          email: "user@example.com",
          status: "pending",
          expiresAt: futureDate.toISOString(),
          organizationId: "org-1",
          workspaceName: null,
        },
      ]);
      mockDb.orderBy.mockResolvedValueOnce([]);

      const res = await app.request(`${baseUrl}/inv-1/accept`, {
        method: "POST",
      });

      expect(res.status).toBe(200);
      const insertedValues = mockDb.values.mock.calls.map(
        (c) => c[0] as Record<string, unknown>,
      );
      const provisioned = insertedValues.find((v) => v.name);
      expect(provisioned).toMatchObject({
        ownerId: "u1",
        name: "Jane's Workspace",
      });
    });

    it("uses a bare apostrophe for names ending in s", async () => {
      mockSession({
        id: "u1",
        email: "user@example.com",
        name: "James",
        role: "user",
        emailVerified: true,
      });

      const futureDate = new Date();
      futureDate.setDate(futureDate.getDate() + 7);

      mockDb.limit.mockResolvedValueOnce([
        {
          id: "inv-1",
          email: "user@example.com",
          status: "pending",
          expiresAt: futureDate.toISOString(),
          organizationId: "org-1",
          workspaceName: null,
        },
      ]);
      mockDb.orderBy.mockResolvedValueOnce([]);

      const res = await app.request(`${baseUrl}/inv-1/accept`, {
        method: "POST",
      });

      expect(res.status).toBe(200);
      const insertedValues = mockDb.values.mock.calls.map(
        (c) => c[0] as Record<string, unknown>,
      );
      const provisioned = insertedValues.find((v) => v.name);
      expect(provisioned).toMatchObject({ name: "James' Workspace" });
    });

    it("clamps a long member name to the workspace name limit", async () => {
      mockSession({
        id: "u1",
        email: "user@example.com",
        name: "Maximilian Alexander Bartholomew",
        role: "user",
        emailVerified: true,
      });

      const futureDate = new Date();
      futureDate.setDate(futureDate.getDate() + 7);

      mockDb.limit.mockResolvedValueOnce([
        {
          id: "inv-1",
          email: "user@example.com",
          status: "pending",
          expiresAt: futureDate.toISOString(),
          organizationId: "org-1",
          workspaceName: null,
        },
      ]);
      mockDb.orderBy.mockResolvedValueOnce([]);

      const res = await app.request(`${baseUrl}/inv-1/accept`, {
        method: "POST",
      });

      expect(res.status).toBe(200);
      const insertedValues = mockDb.values.mock.calls.map(
        (c) => c[0] as Record<string, unknown>,
      );
      const provisioned = insertedValues.find(
        (v): v is { name: string } => typeof v === "object" && "name" in v,
      );
      expect(provisioned?.name.length).toBeLessThanOrEqual(30);
      expect(provisioned?.name.endsWith(" Workspace")).toBe(true);
    });

    it("applies the invitation's ordered blueprints (Tier 1 union, Tier 2 last-write-wins)", async () => {
      mockSession({
        id: "u1",
        email: "user@example.com",
        name: "Jane",
        role: "user",
        emailVerified: true,
      });

      const futureDate = new Date();
      futureDate.setDate(futureDate.getDate() + 7);

      mockDb.limit.mockResolvedValueOnce([
        {
          id: "inv-1",
          email: "user@example.com",
          status: "pending",
          expiresAt: futureDate.toISOString(),
          organizationId: "org-1",
          workspaceName: "Provisioned",
        },
      ]);
      mockDb.orderBy.mockResolvedValueOnce([
        { blueprintId: "bp-1" },
        { blueprintId: "bp-2" },
      ]);
      mockDb.where
        .mockReturnValueOnce(mockDb)
        .mockReturnValueOnce(mockDb)
        .mockReturnValueOnce(mockDb)
        .mockResolvedValueOnce([
          {
            id: "bp-1",
            taskModelProviderId: "prov-A",
            memoryExtractionProviderId: null,
            memoryEmbeddingProviderId: null,
            context: "ctx-1",
          },
          {
            id: "bp-2",
            taskModelProviderId: "prov-B",
            memoryExtractionProviderId: null,
            memoryEmbeddingProviderId: null,
            context: null,
          },
        ])
        .mockResolvedValueOnce([
          { resourceType: "agent", resourceId: "agent-1" },
          { resourceType: "agent", resourceId: "agent-1" },
          { resourceType: "skill", resourceId: "skill-1" },
        ]);
      mockDb.returning.mockResolvedValueOnce([
        { id: "att-1" },
        { id: "att-2" },
      ]);

      const res = await app.request(`${baseUrl}/inv-1/accept`, {
        method: "POST",
      });

      expect(res.status).toBe(200);

      const attachInsert = mockDb.values.mock.calls
        .map((c) => c[0])
        .find(
          (v): v is { resourceType: string; resourceId: string }[] =>
            Array.isArray(v) &&
            (v as { resourceType?: unknown }[])[0]?.resourceType !== undefined,
        );
      expect(attachInsert).toHaveLength(2);
      expect(attachInsert?.map((a) => a.resourceId).sort()).toEqual([
        "agent-1",
        "skill-1",
      ]);

      const tier2Set = mockDb.set.mock.calls
        .map((c) => c[0] as Record<string, unknown>)
        .find((v) => v.taskModelProviderId !== undefined);
      expect(tier2Set).toMatchObject({
        taskModelProviderId: "prov-B",
        context: "ctx-1",
      });
    });

    it("provisions an empty workspace and attaches nothing for a blueprint-less invite", async () => {
      mockSession({
        id: "u1",
        email: "user@example.com",
        name: "Jane",
        role: "user",
        emailVerified: true,
      });

      const futureDate = new Date();
      futureDate.setDate(futureDate.getDate() + 7);

      mockDb.limit.mockResolvedValueOnce([
        {
          id: "inv-1",
          email: "user@example.com",
          status: "pending",
          expiresAt: futureDate.toISOString(),
          organizationId: "org-1",
          workspaceName: null,
        },
      ]);
      mockDb.orderBy.mockResolvedValueOnce([]);

      const res = await app.request(`${baseUrl}/inv-1/accept`, {
        method: "POST",
      });

      expect(res.status).toBe(200);
      const attachInsert = mockDb.values.mock.calls
        .map((c) => c[0])
        .find(
          (v): v is { resourceType: string }[] =>
            Array.isArray(v) &&
            (v as { resourceType?: unknown }[])[0]?.resourceType !== undefined,
        );
      expect(attachInsert).toBeUndefined();
    });

    it("should return 410 if invitation expired", async () => {
      mockSession({
        id: "u1",
        email: "user@example.com",
        role: "user",
        emailVerified: true,
      });

      const pastDate = new Date();
      pastDate.setDate(pastDate.getDate() - 1);

      const mockInvitation = {
        id: "inv-1",
        email: "user@example.com",
        status: "pending",
        expiresAt: pastDate.toISOString(),
      };

      mockDb.limit.mockResolvedValueOnce([mockInvitation]);

      const res = await app.request(`${baseUrl}/inv-1/accept`, {
        method: "POST",
      });

      expect(res.status).toBe(410);
      expect(await res.json()).toEqual({ error: "Invitation has expired" });
    });
  });

  describe("POST /:invitationId/decline", () => {
    const decline = (id: string) =>
      app.request(`${baseUrl}/${id}/decline`, { method: "POST" });

    it("should decline invitation", async () => {
      mockSession({
        id: "u1",
        email: "user@example.com",
        role: "user",
        emailVerified: true,
      });
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
      mockSession({
        id: "u1",
        email: "user@example.com",
        role: "user",
        emailVerified: true,
      });
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
    const invitee = {
      id: "u1",
      email: "user@example.com",
      name: "Jane",
      role: "user",
      emailVerified: true,
    };

    const createInvitationAs = async (typedEmail: string): Promise<string> => {
      mockSession({
        id: "admin-1",
        email: "admin@example.com",
        role: "user",
        emailVerified: true,
      });
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]);
      mockDb.returning.mockResolvedValueOnce([{ id: "inv-1" }]);

      const res = await app.request("/organizations/org-1/invitations", {
        method: "POST",
        body: JSON.stringify({ email: typedEmail }),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(201);

      const row = mockDb.values.mock.calls
        .map((c) => c[0] as Record<string, unknown>)
        .find((v) => "organizationId" in v && "email" in v);
      expect(row).toBeDefined();
      return row!.email as string;
    };

    it("is listed, accepted and declined by the lower-case account", async () => {
      const storedEmail = await createInvitationAs("User@Example.COM");

      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 7);

      const storedRow = {
        id: "inv-1",
        email: storedEmail,
        status: "pending",
        organizationId: "org-1",
        workspaceName: "Contractor Sandbox",
        expiresAt: expiresAt.toISOString(),
        organizationName: "Org 1",
        invitedByName: "Admin",
      };

      const rowsVisibleTo = (email: string) =>
        storedRow.email === email ? [storedRow] : [];

      resetChain();
      mockSession(invitee);
      mockDb.where.mockResolvedValueOnce(rowsVisibleTo(invitee.email));

      const listRes = await app.request(baseUrl);
      expect(listRes.status).toBe(200);
      expect(await listRes.json()).toEqual({ results: [storedRow] });

      resetChain();
      mockSession(invitee);
      mockDb.limit.mockResolvedValueOnce(rowsVisibleTo(invitee.email));
      mockDb.orderBy.mockResolvedValueOnce([]);

      const acceptRes = await app.request(`${baseUrl}/inv-1/accept`, {
        method: "POST",
      });
      expect(acceptRes.status).toBe(200);

      const provisioned = mockDb.values.mock.calls
        .map((c) => c[0] as Record<string, unknown>)
        .find((v) => v.name);
      expect(await acceptRes.json()).toEqual({
        message: "Invitation accepted",
        organizationId: "org-1",
        workspaceId: provisioned!.id,
      });
      expect(provisioned).toMatchObject({
        organizationId: "org-1",
        ownerId: "u1",
        name: "Contractor Sandbox",
      });

      resetChain();
      mockSession(invitee);
      mockDb.returning.mockResolvedValueOnce(
        rowsVisibleTo(invitee.email).map((r) => ({ ...r, status: "declined" })),
      );

      const declineRes = await app.request(`${baseUrl}/inv-1/decline`, {
        method: "POST",
      });
      expect(declineRes.status).toBe(200);
      expect(await declineRes.json()).toEqual({
        message: "Invitation declined",
      });
    });
  });
});
