import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockDb, mockSession, resetMockDb } from "../test-utils.ts";
import app from "../server.ts";

describe("User Invitation Routes", () => {
  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
    mockDb.where.mockReturnValue(mockDb);
    mockDb.innerJoin.mockReturnValue(mockDb);
  });

  const baseUrl = "/users/me/invitations";

  describe("GET /", () => {
    it("should list pending invitations for user", async () => {
      mockSession({ id: "u1", email: "user@example.com", role: "user" });

      const futureDate = new Date();
      futureDate.setDate(futureDate.getDate() + 7);

      const mockInvitations = [
        {
          id: "inv-1",
          email: "user@example.com",
          status: "pending",
          expiresAt: futureDate.toISOString(),
          organizationName: "Org 1",
          workspaceName: "WS 1",
          invitedByName: "Admin",
        },
      ];

      mockDb.where.mockResolvedValueOnce(mockInvitations);

      const res = await app.request(baseUrl);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ results: mockInvitations });
    });
  });

  describe("POST /:invitationId/accept", () => {
    it("should accept invitation and provision a workspace with the invite name", async () => {
      mockSession({
        id: "u1",
        email: "user@example.com",
        name: "Jane",
        role: "user",
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

      mockDb.limit.mockResolvedValueOnce([mockInvitation]); // fetch invitation

      // Transaction mocks
      mockDb.limit.mockResolvedValueOnce([]); // check org membership (none)
      mockDb.orderBy.mockResolvedValueOnce([]); // no blueprints on the invite

      const res = await app.request(`${baseUrl}/inv-1/accept`, {
        method: "POST",
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ message: "Invitation accepted" });
      expect(mockDb.transaction).toHaveBeenCalled();

      // ADR-0008: accepting always provisions a workspace owned by the
      // acceptor, using the invitation's workspace name.
      const insertedValues = mockDb.values.mock.calls.map((c) => c[0]);
      const provisioned = insertedValues.find((v) => v?.name);
      expect(provisioned).toMatchObject({
        organizationId: "org-1",
        ownerId: "u1",
        name: "Contractor Sandbox",
      });
    });

    // ADR-0008: a blueprint-less / unnamed invite yields an empty workspace
    // named "<member name>'s Workspace".
    it("should default the workspace name to the member's name", async () => {
      mockSession({
        id: "u1",
        email: "user@example.com",
        name: "Jane",
        role: "user",
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
      ]); // fetch invitation
      mockDb.limit.mockResolvedValueOnce([]); // check org membership (none)
      mockDb.orderBy.mockResolvedValueOnce([]); // no blueprints on the invite

      const res = await app.request(`${baseUrl}/inv-1/accept`, {
        method: "POST",
      });

      expect(res.status).toBe(200);
      const insertedValues = mockDb.values.mock.calls.map((c) => c[0]);
      const provisioned = insertedValues.find((v) => v?.name);
      expect(provisioned).toMatchObject({
        ownerId: "u1",
        name: "Jane's Workspace",
      });
    });

    // A name ending in "s" takes a bare possessive apostrophe.
    it("uses a bare apostrophe for names ending in s", async () => {
      mockSession({
        id: "u1",
        email: "user@example.com",
        name: "James",
        role: "user",
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
      ]); // fetch invitation
      mockDb.limit.mockResolvedValueOnce([]); // check org membership (none)
      mockDb.orderBy.mockResolvedValueOnce([]); // no blueprints on the invite

      const res = await app.request(`${baseUrl}/inv-1/accept`, {
        method: "POST",
      });

      expect(res.status).toBe(200);
      const insertedValues = mockDb.values.mock.calls.map((c) => c[0]);
      const provisioned = insertedValues.find((v) => v?.name);
      expect(provisioned).toMatchObject({ name: "James' Workspace" });
    });

    // The default name must stay within the schema's 30-char max so the
    // provisioned workspace remains editable.
    it("clamps a long member name to the workspace name limit", async () => {
      mockSession({
        id: "u1",
        email: "user@example.com",
        name: "Maximilian Alexander Bartholomew",
        role: "user",
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
      ]); // fetch invitation
      mockDb.limit.mockResolvedValueOnce([]); // check org membership (none)
      mockDb.orderBy.mockResolvedValueOnce([]); // no blueprints on the invite

      const res = await app.request(`${baseUrl}/inv-1/accept`, {
        method: "POST",
      });

      expect(res.status).toBe(200);
      const insertedValues = mockDb.values.mock.calls.map((c) => c[0]);
      const provisioned = insertedValues.find((v) => v?.name);
      expect(provisioned.name.length).toBeLessThanOrEqual(30);
      expect(provisioned.name.endsWith(" Workspace")).toBe(true);
    });

    // ADR-0009: accepting a Blueprint-bearing invite provisions the Workspace
    // and runs each macro in order — Tier 1 Attachments compose as a union;
    // Tier 2 conflicts resolve last-write-wins by position.
    it("applies the invitation's ordered blueprints (Tier 1 union, Tier 2 last-write-wins)", async () => {
      mockSession({
        id: "u1",
        email: "user@example.com",
        name: "Jane",
        role: "user",
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
      ]); // fetch invitation
      mockDb.limit.mockResolvedValueOnce([]); // check org membership (none)
      // Ordered set: bp-1 then bp-2.
      mockDb.orderBy.mockResolvedValueOnce([
        { blueprintId: "bp-1" },
        { blueprintId: "bp-2" },
      ]);
      // applyBlueprintsToWorkspace: Tier 2 source rows (unordered), then items.
      mockDb.where
        .mockReturnValueOnce(mockDb) // fetch invitation -> limit
        .mockReturnValueOnce(mockDb) // org membership -> limit
        .mockReturnValueOnce(mockDb) // ordered blueprints -> orderBy
        .mockResolvedValueOnce([
          // bp-1 sets the task provider; bp-2 overrides it (last wins).
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
        ]) // blueprint Tier 2 select
        .mockResolvedValueOnce([
          // Union: agent-1 appears in both blueprints; skill-1 only in bp-2.
          { resourceType: "agent", resourceId: "agent-1" },
          { resourceType: "agent", resourceId: "agent-1" },
          { resourceType: "skill", resourceId: "skill-1" },
        ]); // blueprint items select
      mockDb.returning.mockResolvedValueOnce([
        { id: "att-1" },
        { id: "att-2" },
      ]); // attachments inserted

      const res = await app.request(`${baseUrl}/inv-1/accept`, {
        method: "POST",
      });

      expect(res.status).toBe(200);

      // Tier 1: the attachment insert receives the deduped union (2 distinct).
      const attachInsert = mockDb.values.mock.calls
        .map((c) => c[0])
        .find((v) => Array.isArray(v) && v[0]?.resourceType);
      expect(attachInsert).toHaveLength(2);
      expect(attachInsert.map((a: any) => a.resourceId).sort()).toEqual([
        "agent-1",
        "skill-1",
      ]);

      // Tier 2: the later blueprint (bp-2) wins on taskModelProviderId; the
      // null slot it leaves does not clobber bp-1's earlier context.
      const tier2Set = mockDb.set.mock.calls
        .map((c) => c[0])
        .find((v) => v?.taskModelProviderId !== undefined);
      expect(tier2Set).toMatchObject({
        taskModelProviderId: "prov-B",
        context: "ctx-1",
      });
    });

    // ADR-0009: a Blueprint-less invite still provisions an empty Workspace and
    // applies nothing (unchanged from #153).
    it("provisions an empty workspace and attaches nothing for a blueprint-less invite", async () => {
      mockSession({
        id: "u1",
        email: "user@example.com",
        name: "Jane",
        role: "user",
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
      ]); // fetch invitation
      mockDb.limit.mockResolvedValueOnce([]); // check org membership (none)
      mockDb.orderBy.mockResolvedValueOnce([]); // no blueprints

      const res = await app.request(`${baseUrl}/inv-1/accept`, {
        method: "POST",
      });

      expect(res.status).toBe(200);
      // No attachment insert ran — the service early-returns on an empty set.
      const attachInsert = mockDb.values.mock.calls
        .map((c) => c[0])
        .find((v) => Array.isArray(v) && v[0]?.resourceType);
      expect(attachInsert).toBeUndefined();
    });

    it("should return 410 if invitation expired", async () => {
      mockSession({ id: "u1", email: "user@example.com", role: "user" });

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
    it("should decline invitation", async () => {
      mockSession({ id: "u1", email: "user@example.com", role: "user" });

      mockDb.returning.mockResolvedValueOnce([
        { id: "inv-1", status: "declined" },
      ]);

      const res = await app.request(`${baseUrl}/inv-1/decline`, {
        method: "POST",
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ message: "Invitation declined" });
    });
  });
});
