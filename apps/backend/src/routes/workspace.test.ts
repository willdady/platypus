import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockDb, mockSession, resetMockDb } from "../test-utils.ts";
import app from "../server.ts";
import { resolveScoped } from "../services/scoped-resource.ts";

// The memory pointer-settings must resolve through the Scoped resource
// authority, not a bare id lookup (GHSA-qg7h-g2rm-37qh). Spy on it so the tests
// assert the route delegates the scoping decision — the chained mockDb ignores
// WHERE predicates and cannot itself tell a scoped lookup from a global one.
vi.mock("../services/scoped-resource.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/scoped-resource.ts")>()),
  resolveScoped: vi.fn(),
}));
const resolveScopedMock = vi.mocked(resolveScoped);

describe("Workspace Routes", () => {
  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();

    // Force reset where to ensure it returns mockDb
    mockDb.where.mockReturnValue(mockDb);
  });

  describe("POST /organizations/:orgId/workspaces", () => {
    // ADR-0008: Workspace creation is org-admin-only.
    it("should create workspace for an org admin", async () => {
      mockSession({ id: "user-1", role: "user" });

      // Mock requireOrgAccess: return admin role
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]);

      // Mock insert
      const mockWorkspace = { id: "ws-1", name: "New Workspace" };
      mockDb.returning.mockResolvedValueOnce([mockWorkspace]);

      const res = await app.request("/organizations/org-1/workspaces", {
        method: "POST",
        body: JSON.stringify({
          name: "New Workspace",
          organizationId: "org-1",
        }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(201);
      expect(await res.json()).toEqual(mockWorkspace);
      // Owner defaults to the calling admin when no ownerId is supplied.
      const insertedValues = mockDb.values.mock.calls.at(-1)?.[0];
      expect(insertedValues).toMatchObject({
        ownerId: "user-1",
        organizationId: "org-1",
      });
    });

    // ADR-0008: a regular member can no longer self-create Workspaces.
    it("should return 403 for a regular member", async () => {
      mockSession({ id: "user-1", role: "user" });

      // Mock requireOrgAccess: return member role
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);

      const res = await app.request("/organizations/org-1/workspaces", {
        method: "POST",
        body: JSON.stringify({
          name: "New Workspace",
          organizationId: "org-1",
        }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(403);
      expect(mockDb.insert).not.toHaveBeenCalled();
    });

    // ADR-0008: ownerId is admin-assignable to another org member.
    it("should let an admin assign a different owner who is a member", async () => {
      mockSession({ id: "admin-1", role: "user" });

      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ userId: "member-2" }]); // owner is a member
      const mockWorkspace = { id: "ws-1", name: "Member Workspace" };
      mockDb.returning.mockResolvedValueOnce([mockWorkspace]);

      const res = await app.request("/organizations/org-1/workspaces", {
        method: "POST",
        body: JSON.stringify({
          name: "Member Workspace",
          organizationId: "org-1",
          ownerId: "member-2",
        }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(201);
      const insertedValues = mockDb.values.mock.calls.at(-1)?.[0];
      expect(insertedValues).toMatchObject({
        ownerId: "member-2",
        organizationId: "org-1",
      });
    });

    // Governance: an admin cannot hand a workspace to a non-member.
    it("should return 400 when the assigned owner is not an org member", async () => {
      mockSession({ id: "admin-1", role: "user" });

      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([]); // owner not a member

      const res = await app.request("/organizations/org-1/workspaces", {
        method: "POST",
        body: JSON.stringify({
          name: "Member Workspace",
          organizationId: "org-1",
          ownerId: "outsider",
        }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: "Owner must be a member of the organization",
      });
      expect(mockDb.insert).not.toHaveBeenCalled();
    });
  });

  describe("GET /organizations/:orgId/workspaces", () => {
    it("should return all workspaces for org admin", async () => {
      mockSession({ id: "user-1", role: "user" });
      const mockWorkspaces = [{ id: "ws-1", name: "WS 1" }];

      // Mock requireOrgAccess: return admin role
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]);

      // Mock list workspaces
      mockDb.where
        .mockReturnValueOnce(mockDb)
        .mockResolvedValueOnce(mockWorkspaces);

      const res = await app.request("/organizations/org-1/workspaces");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ results: mockWorkspaces });
    });

    it("should return only owned workspaces for regular member", async () => {
      mockSession({ id: "user-1", role: "user" });
      const mockWorkspaces = [{ id: "ws-1", name: "WS 1" }];

      // Mock requireOrgAccess: return member role
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);

      // Mock get owned workspaces (single query with and(orgId, ownerId))
      mockDb.where
        .mockReturnValueOnce(mockDb) // requireOrgAccess
        .mockResolvedValueOnce(mockWorkspaces); // owned workspaces

      const res = await app.request("/organizations/org-1/workspaces");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ results: mockWorkspaces });
    });
  });

  describe("GET /organizations/:orgId/workspaces/:workspaceId", () => {
    it("should return workspace", async () => {
      mockSession({ id: "user-1", role: "user" });
      const mockWorkspace = { id: "ws-1", name: "WS 1" };

      // Mock requireOrgAccess: return member role
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
      // Mock requireWorkspaceAccess: workspace owned by user
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]);
      // Mock get workspace
      mockDb.limit.mockResolvedValueOnce([mockWorkspace]);

      const res = await app.request("/organizations/org-1/workspaces/ws-1");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(mockWorkspace);
    });

    it("should return 404 if workspace not found", async () => {
      mockSession({ id: "user-1", role: "user" });

      // Mock requireOrgAccess: return member role
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
      // Mock requireWorkspaceAccess: workspace not found
      mockDb.limit.mockResolvedValueOnce([]);

      const res = await app.request("/organizations/org-1/workspaces/ws-1");
      expect(res.status).toBe(404);
    });
  });

  describe("PUT /organizations/:orgId/workspaces/:workspaceId", () => {
    it("should update workspace if owner", async () => {
      mockSession({ id: "user-1", role: "user" });
      const mockWorkspace = { id: "ws-1", name: "Updated WS" };

      // Mock requireOrgAccess: return member role
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
      // Mock requireWorkspaceAccess: workspace owned by user
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]);

      // Mock update
      mockDb.returning.mockResolvedValueOnce([mockWorkspace]);

      const res = await app.request("/organizations/org-1/workspaces/ws-1", {
        method: "PUT",
        body: JSON.stringify({ name: "Updated WS" }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(mockWorkspace);
    });

    // ADR-0006: delegation flags are admin-only; a non-admin owner's attempt
    // to set them is silently stripped before the update.
    it("strips delegation flags from a non-admin owner's update", async () => {
      mockSession({ id: "user-1", role: "user" });
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]); // requireWorkspaceAccess
      mockDb.returning.mockResolvedValueOnce([
        { id: "ws-1", name: "My Workspace" },
      ]);

      const res = await app.request("/organizations/org-1/workspaces/ws-1", {
        method: "PUT",
        body: JSON.stringify({
          name: "My Workspace",
          providerSelfManagement: true,
          mcpSelfManagement: true,
        }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(200);
      const setArg = mockDb.set.mock.calls.at(-1)?.[0];
      expect(setArg).not.toHaveProperty("providerSelfManagement");
      expect(setArg).not.toHaveProperty("mcpSelfManagement");
    });

    // Security (GHSA-qg7h-g2rm-37qh): a memory Provider pointer must resolve
    // through the Scoped resource authority, scoped to this Workspace, so a
    // Provider not visible here — e.g. one owned by another Organization —
    // resolves to null and is rejected, never stamped. Asserting the delegation
    // (not just the 404) is what pins the fix: the vulnerable code did a bare id
    // lookup and never called resolveScoped.
    it("rejects a memory provider not visible in the workspace", async () => {
      mockSession({ id: "user-1", role: "user" });
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]); // requireWorkspaceAccess
      resolveScopedMock.mockResolvedValueOnce(null); // not visible in (org-1, ws-1)

      const res = await app.request("/organizations/org-1/workspaces/ws-1", {
        method: "PUT",
        body: JSON.stringify({
          name: "My Workspace",
          memoryExtractionProviderId: "provider-other-org",
        }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({
        error: "Memory extraction provider not found",
      });
      expect(resolveScopedMock).toHaveBeenCalledWith(
        expect.anything(),
        "provider",
        "provider-other-org",
        { orgId: "org-1", wsId: "ws-1" },
      );
      expect(mockDb.update).not.toHaveBeenCalled();
    });

    it("accepts a workspace-visible memory provider that has the model", async () => {
      mockSession({ id: "user-1", role: "user" });
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]); // requireWorkspaceAccess
      resolveScopedMock.mockResolvedValueOnce({
        row: {
          id: "provider-1",
          memoryExtractionModelId: "model-x",
        } as never,
        scope: "workspace",
      });
      mockDb.returning.mockResolvedValueOnce([
        { id: "ws-1", name: "My Workspace" },
      ]);

      const res = await app.request("/organizations/org-1/workspaces/ws-1", {
        method: "PUT",
        body: JSON.stringify({
          name: "My Workspace",
          memoryExtractionProviderId: "provider-1",
        }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(200);
      expect(mockDb.update).toHaveBeenCalled();
    });

    it("lets an org admin set delegation flags", async () => {
      mockSession({ id: "user-1", role: "user" });
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-2", organizationId: "org-1" },
      ]); // requireWorkspaceAccess (admin, not owner)
      mockDb.returning.mockResolvedValueOnce([
        { id: "ws-1", name: "My Workspace" },
      ]);

      const res = await app.request("/organizations/org-1/workspaces/ws-1", {
        method: "PUT",
        body: JSON.stringify({ name: "My Workspace", mcpSelfManagement: true }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(200);
      const setArg = mockDb.set.mock.calls.at(-1)?.[0];
      expect(setArg).toMatchObject({ mcpSelfManagement: true });
    });
  });

  describe("DELETE /organizations/:orgId/workspaces/:workspaceId", () => {
    it("should delete workspace if owner", async () => {
      mockSession({ id: "user-1", role: "user" });

      // Mock requireOrgAccess: return member role
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
      // Mock requireWorkspaceAccess: workspace owned by user
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]);

      // Mock delete — order: orgAccess where (chained) → workspaceAccess where
      // (chained) → destroyWorkspaceSandboxes select-where (resolves []) →
      // workspace delete where (resolves).
      mockDb.where
        .mockReturnValueOnce(mockDb)
        .mockReturnValueOnce(mockDb)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      const res = await app.request("/organizations/org-1/workspaces/ws-1", {
        method: "DELETE",
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ message: "Workspace deleted" });
    });
  });
});
