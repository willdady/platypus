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

      const res = await app.request(`${baseUrl}/inv-1/accept`, {
        method: "POST",
      });

      expect(res.status).toBe(200);
      const insertedValues = mockDb.values.mock.calls.map((c) => c[0]);
      const provisioned = insertedValues.find((v) => v?.name);
      expect(provisioned.name.length).toBeLessThanOrEqual(30);
      expect(provisioned.name.endsWith(" Workspace")).toBe(true);
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
