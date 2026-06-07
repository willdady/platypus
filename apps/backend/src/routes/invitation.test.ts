import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockDb, mockSession, resetMockDb } from "../test-utils.ts";
import app from "../server.ts";

describe("Invitation Routes", () => {
  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
    mockDb.where.mockReturnValue(mockDb);
    mockDb.innerJoin.mockReturnValue(mockDb);
  });

  const orgId = "org-1";
  const baseUrl = `/organizations/${orgId}/invitations`;

  describe("POST /", () => {
    it("should create invitation if org admin", async () => {
      mockSession({ id: "admin-1", email: "admin@example.com", role: "user" });
      // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]);
      // Verify workspace belongs to org
      mockDb.limit.mockResolvedValueOnce([
        { id: "ws-1", organizationId: orgId },
      ]);

      const mockInvitation = {
        id: "inv-1",
        email: "user@example.com",
        workspaceId: "ws-1",
      };
      mockDb.returning.mockResolvedValueOnce([mockInvitation]);

      const res = await app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify({
          email: "user@example.com",
          workspaceId: "ws-1",
          role: "editor",
        }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(201);
      // The response echoes the ordered blueprint set (empty here, ADR-0009).
      expect(await res.json()).toEqual({ ...mockInvitation, blueprintIds: [] });
    });

    // ADR-0009: an invitation carries an ordered set of Blueprints, stored in
    // the invitation_blueprint junction with `position`.
    it("persists an ordered set of blueprints", async () => {
      mockSession({ id: "admin-1", email: "admin@example.com", role: "user" });
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]); // requireOrgAccess
      // Blueprint validation: both ids resolve to org-scoped blueprints.
      mockDb.where
        .mockReturnValueOnce(mockDb) // requireOrgAccess
        .mockResolvedValueOnce([{ id: "bp-1" }, { id: "bp-2" }]); // validation
      mockDb.returning.mockResolvedValueOnce([{ id: "inv-1" }]);

      const res = await app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify({
          email: "user@example.com",
          // Duplicate bp-1 — the set dedupes while preserving order.
          blueprintIds: ["bp-1", "bp-2", "bp-1"],
        }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(201);
      expect((await res.json()).blueprintIds).toEqual(["bp-1", "bp-2"]);

      // The junction insert carries the ordered, deduped set with positions.
      const junctionInsert = mockDb.values.mock.calls
        .map((c) => c[0])
        .find((v) => Array.isArray(v) && v[0]?.blueprintId);
      expect(junctionInsert).toEqual([
        expect.objectContaining({ blueprintId: "bp-1", position: 0 }),
        expect.objectContaining({ blueprintId: "bp-2", position: 1 }),
      ]);
    });

    it("422s when a blueprint is not in this organization", async () => {
      mockSession({ id: "admin-1", email: "admin@example.com", role: "user" });
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]); // requireOrgAccess
      // Only bp-1 resolves; bp-2 is foreign / missing.
      mockDb.where
        .mockReturnValueOnce(mockDb) // requireOrgAccess
        .mockResolvedValueOnce([{ id: "bp-1" }]); // validation

      const res = await app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify({
          email: "user@example.com",
          blueprintIds: ["bp-1", "bp-2"],
        }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(422);
      expect((await res.json()).missingBlueprintIds).toEqual(["bp-2"]);
    });

    // ADR-0008: the invitation carries an optional Workspace name used to
    // provision the acceptor's workspace.
    it("should persist an optional workspaceName", async () => {
      mockSession({ id: "admin-1", email: "admin@example.com", role: "user" });
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]); // requireOrgAccess
      mockDb.returning.mockResolvedValueOnce([{ id: "inv-1" }]);

      const res = await app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify({
          email: "user@example.com",
          workspaceName: "Contractor Sandbox",
        }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(201);
      const insertedValues = mockDb.values.mock.calls.at(-1)?.[0];
      expect(insertedValues).toMatchObject({
        email: "user@example.com",
        workspaceName: "Contractor Sandbox",
      });
    });

    it("should return 400 if inviting self", async () => {
      mockSession({ id: "admin-1", email: "admin@example.com", role: "user" });
      // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]);

      const res = await app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify({
          email: "admin@example.com",
          workspaceId: "ws-1",
          role: "editor",
        }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: "You cannot invite yourself",
      });
    });
  });

  describe("GET /", () => {
    it("should list invitations, each with its ordered blueprint set", async () => {
      mockSession();
      // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]);

      const mockInvitations = [
        { id: "inv-1", email: "a@example.com", workspaceName: "WS 1" },
        { id: "inv-2", email: "b@example.com", workspaceName: "WS 2" },
      ];
      mockDb.where
        .mockReturnValueOnce(mockDb) // requireOrgAccess
        .mockResolvedValueOnce(mockInvitations); // list invitations
      // Junction rows for the listed invitations (already in position order).
      mockDb.orderBy.mockResolvedValueOnce([
        { invitationId: "inv-1", blueprintId: "bp-1" },
        { invitationId: "inv-1", blueprintId: "bp-2" },
      ]);

      const res = await app.request(baseUrl);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.results[0].blueprintIds).toEqual(["bp-1", "bp-2"]);
      // An invite with no blueprints reports an empty set, not undefined.
      expect(json.results[1].blueprintIds).toEqual([]);
    });
  });

  describe("DELETE /:invitationId", () => {
    it("should delete invitation", async () => {
      mockSession();
      // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]);

      mockDb.where.mockReturnValueOnce(mockDb).mockReturnValueOnce(mockDb);
      mockDb.returning.mockResolvedValueOnce([{ id: "inv-1" }]);

      const res = await app.request(`${baseUrl}/inv-1`, {
        method: "DELETE",
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ message: "Invitation deleted" });
    });
  });
});
