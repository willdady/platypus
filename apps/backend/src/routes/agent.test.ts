import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  mockDb,
  mockSession,
  mockNoSession,
  resetMockDb,
} from "../test-utils.ts";
import app from "../server.ts";

describe("Agent Routes", () => {
  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
    mockDb.where.mockReturnValue(mockDb);
  });

  const orgId = "org-1";
  const workspaceId = "ws-1";
  const baseUrl = `/organizations/${orgId}/workspaces/${workspaceId}/agents`;

  describe("POST /", () => {
    it("should return 401 if not authenticated", async () => {
      mockNoSession();
      const res = await app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify({
          name: "New Agent",
          providerId: "p1",
          modelId: "m1",
        }),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(401);
    });

    it("should return 403 if user has no workspace access", async () => {
      mockSession();
      // requireOrgAccess: returns membership
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
      // requireWorkspaceAccess: workspace not owned by user
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "other-user", organizationId: "org-1" },
      ]);

      const res = await app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify({
          name: "New Agent",
          providerId: "p1",
          modelId: "m1",
        }),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(403);
    });

    it("should create agent if user is editor", async () => {
      mockSession();
      // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
      // requireWorkspaceAccess
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]);

      const mockAgent = { id: "agent-1", name: "New Agent", workspaceId };
      mockDb.returning.mockResolvedValueOnce([mockAgent]);

      const res = await app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify({
          name: "New Agent",
          description: "A test agent",
          providerId: "p1",
          modelId: "m1",
          workspaceId,
        }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(201);
      expect(await res.json()).toEqual(mockAgent);
      expect(mockDb.insert).toHaveBeenCalled();
    });

    it("should return 400 if description is too long", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]);

      const longDescription = "a".repeat(129);

      const res = await app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify({
          name: "New Agent",
          providerId: "p1",
          modelId: "m1",
          workspaceId,
          description: longDescription,
        }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as {
        success: boolean;
        error: { code: string; path: string[] }[];
      };
      expect(body.success).toBe(false);
      expect(Array.isArray(body.error)).toBe(true);
      expect(body.error[0].code).toBe("too_big");
      expect(body.error[0].path).toContain("description");
    });
  });

  describe("GET /", () => {
    it("should list workspace and attached org agents tagged with scope", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]);

      const workspaceAgents = [{ id: "agent-1", name: "Agent 1" }];
      // The attached org-scoped Agents come back from an inner join, shaped
      // { agent: {...} }.
      const attachedOrgRows = [
        { agent: { id: "org-agent-1", name: "Shared Agent" } },
      ];
      mockDb.where
        .mockReturnValueOnce(mockDb) // requireOrgAccess
        .mockReturnValueOnce(mockDb) // requireWorkspaceAccess
        .mockResolvedValueOnce(workspaceAgents) // workspace-scoped query
        .mockResolvedValueOnce(attachedOrgRows); // attached org-scoped query

      const res = await app.request(baseUrl);
      expect(res.status).toBe(200);
      // listScoped returns Workspace rows first, then attached org rows; the
      // frontend regroups by scope, so order is not observable behaviour.
      expect(await res.json()).toEqual({
        results: [
          { id: "agent-1", name: "Agent 1", scope: "workspace" },
          { id: "org-agent-1", name: "Shared Agent", scope: "organization" },
        ],
      });
    });
  });

  describe("GET /:agentId", () => {
    it("should return 404 if agent not found", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]);
      // findVisibleAgent lookup → none
      mockDb.limit.mockResolvedValueOnce([]);

      const res = await app.request(`${baseUrl}/agent-1`);
      expect(res.status).toBe(404);
    });

    it("should return a workspace agent tagged scope workspace", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]);
      // findVisibleAgent lookup → workspace-scoped agent
      mockDb.limit.mockResolvedValueOnce([
        { id: "agent-1", name: "Agent 1", workspaceId },
      ]);

      const res = await app.request(`${baseUrl}/agent-1`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        id: "agent-1",
        name: "Agent 1",
        workspaceId,
        scope: "workspace",
      });
    });

    it("should return an attached org agent tagged scope organization", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]);
      // findVisibleAgent lookup → org-scoped agent
      mockDb.limit.mockResolvedValueOnce([
        { id: "org-agent-1", name: "Shared", organizationId: orgId },
      ]);
      // attachment check → attached here
      mockDb.limit.mockResolvedValueOnce([{ id: "att-1" }]);

      const res = await app.request(`${baseUrl}/org-agent-1`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        id: "org-agent-1",
        name: "Shared",
        organizationId: orgId,
        scope: "organization",
      });
    });

    it("should 404 an org agent that is not attached here", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]);
      // findVisibleAgent lookup → org-scoped agent
      mockDb.limit.mockResolvedValueOnce([
        { id: "org-agent-1", name: "Shared", organizationId: orgId },
      ]);
      // attachment check → not attached
      mockDb.limit.mockResolvedValueOnce([]);

      const res = await app.request(`${baseUrl}/org-agent-1`);
      expect(res.status).toBe(404);
    });
  });

  describe("PUT /:agentId", () => {
    it("should update a workspace agent if user is editor", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]);
      // findVisibleAgent → workspace-scoped agent
      mockDb.limit.mockResolvedValueOnce([{ id: "agent-1", workspaceId }]);

      const mockAgent = { id: "agent-1", name: "Updated Agent" };
      mockDb.returning.mockResolvedValueOnce([mockAgent]);

      const res = await app.request(`${baseUrl}/agent-1`, {
        method: "PUT",
        body: JSON.stringify({
          name: "Updated Agent",
          description: "An updated agent",
          providerId: "p1",
          modelId: "m1",
        }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(mockAgent);
    });

    it("persists a cleared temperature as null instead of keeping the old value (#263)", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]);
      // findVisibleAgent → workspace-scoped agent
      mockDb.limit.mockResolvedValueOnce([{ id: "agent-1", workspaceId }]);

      mockDb.returning.mockResolvedValueOnce([
        { id: "agent-1", name: "Updated Agent", temperature: null },
      ]);

      const res = await app.request(`${baseUrl}/agent-1`, {
        method: "PUT",
        body: JSON.stringify({
          name: "Updated Agent",
          description: "An updated agent",
          providerId: "p1",
          modelId: "m1",
          temperature: null,
        }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(200);
      expect(mockDb.set).toHaveBeenCalledWith(
        expect.objectContaining({ temperature: null }),
      );
    });

    it("should lock a shared agent for a workspace owner (non-admin)", async () => {
      mockSession();
      // requireOrgAccess → member
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]);
      // findVisibleAgent → org-scoped agent
      mockDb.limit.mockResolvedValueOnce([
        { id: "org-agent-1", name: "Shared", organizationId: orgId },
      ]);
      // attachment check → attached here
      mockDb.limit.mockResolvedValueOnce([{ id: "att-1" }]);

      const res = await app.request(`${baseUrl}/org-agent-1`, {
        method: "PUT",
        body: JSON.stringify({
          name: "Hacked",
          description: "nope",
          providerId: "p1",
          modelId: "m1",
        }),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(403);
      expect(mockDb.update).not.toHaveBeenCalled();
    });

    it("locks a shared agent in the workspace even for an org admin (edit on org surface)", async () => {
      mockSession();
      // requireOrgAccess → admin
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]);
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]);
      // findVisibleAgent → org-scoped agent
      mockDb.limit.mockResolvedValueOnce([
        { id: "org-agent-1", name: "Shared", organizationId: orgId },
      ]);
      // attachment check → attached here
      mockDb.limit.mockResolvedValueOnce([{ id: "att-1" }]);

      const res = await app.request(`${baseUrl}/org-agent-1`, {
        method: "PUT",
        body: JSON.stringify({
          name: "Renamed",
          description: "An updated shared agent",
          providerId: "p1",
          modelId: "m1",
        }),
        headers: { "Content-Type": "application/json" },
      });
      // Shared agents are edited only on the Organization surface (ADR-0007).
      expect(res.status).toBe(403);
      expect(mockDb.update).not.toHaveBeenCalled();
    });
  });

  describe("DELETE /:agentId", () => {
    it("should delete a workspace agent if user is workspace owner", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]);
      // Avatar lookup (agent has no avatar) — also confirms workspace row exists
      mockDb.limit.mockResolvedValueOnce([{ avatarKey: null }]);

      const res = await app.request(`${baseUrl}/agent-1`, {
        method: "DELETE",
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ message: "Agent deleted" });
    });

    it("should 404 when deleting a shared agent not attached here", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]);
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]);
      // resolveScoped lookup → none visible here → 404
      mockDb.limit.mockResolvedValueOnce([]);

      const res = await app.request(`${baseUrl}/org-agent-1`, {
        method: "DELETE",
      });
      expect(res.status).toBe(404);
      expect(mockDb.delete).not.toHaveBeenCalled();
    });

    it("should 403 (locked) when deleting an attached shared agent", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]);
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]);
      // resolveScoped lookup → org-scoped agent
      mockDb.limit.mockResolvedValueOnce([
        { id: "org-agent-1", name: "Shared", organizationId: orgId },
      ]);
      // attachment check → attached here, so it is visible but locked
      mockDb.limit.mockResolvedValueOnce([{ id: "att-1" }]);

      const res = await app.request(`${baseUrl}/org-agent-1`, {
        method: "DELETE",
      });
      // Shared agents are deleted only on the Organization surface (ADR-0007).
      expect(res.status).toBe(403);
      expect(mockDb.delete).not.toHaveBeenCalled();
    });
  });

  describe("POST /:agentId/promote", () => {
    const promoteUrl = `${baseUrl}/agent-1/promote`;

    it("returns 403 if not org admin", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);

      const res = await app.request(promoteUrl, { method: "POST" });
      expect(res.status).toBe(403);
    });

    it("returns 404 if the workspace agent does not exist", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]);
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]);
      // agent lookup → not found
      mockDb.limit.mockResolvedValueOnce([]);

      const res = await app.request(promoteUrl, { method: "POST" });
      expect(res.status).toBe(404);
    });

    it("blocks promotion and lists workspace-private references (no-cascade)", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]);
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]);
      // agent lookup: org-scoped provider, but a workspace-private skill
      mockDb.limit.mockResolvedValueOnce([
        {
          id: "agent-1",
          providerId: "p1",
          workspaceId,
          skillIds: ["s1"],
          subAgentIds: [],
          toolSetIds: [],
        },
      ]);

      mockDb.where
        .mockReturnValueOnce(mockDb) // requireOrgAccess
        .mockReturnValueOnce(mockDb) // requireWorkspaceAccess
        .mockReturnValueOnce(mockDb) // agent lookup
        .mockResolvedValueOnce([
          { id: "p1", name: "Shared Provider", organizationId: orgId },
        ]) // provider validation → org-scoped, OK
        .mockResolvedValueOnce([
          { id: "s1", name: "ws-skill", organizationId: null },
        ]); // skills validation → workspace-private, blocker

      const res = await app.request(promoteUrl, { method: "POST" });
      expect(res.status).toBe(422);
      const body = (await res.json()) as { blockers: unknown[] };
      expect(body.blockers).toEqual([
        { type: "skill", id: "s1", name: "ws-skill" },
      ]);
      expect(mockDb.transaction).not.toHaveBeenCalled();
    });

    it("re-scopes the agent to org and auto-attaches the origin workspace", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]);
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]);
      // agent lookup: only an org-scoped provider reference
      mockDb.limit.mockResolvedValueOnce([
        {
          id: "agent-1",
          providerId: "p1",
          workspaceId,
          skillIds: [],
          subAgentIds: [],
          toolSetIds: [],
        },
      ]);

      mockDb.where
        .mockReturnValueOnce(mockDb) // requireOrgAccess
        .mockReturnValueOnce(mockDb) // requireWorkspaceAccess
        .mockReturnValueOnce(mockDb) // agent lookup
        .mockResolvedValueOnce([
          { id: "p1", name: "Shared Provider", organizationId: orgId },
        ]); // provider validation → org-scoped, OK

      mockDb.returning.mockResolvedValueOnce([
        { id: "agent-1", organizationId: orgId, workspaceId: null },
      ]);

      const res = await app.request(promoteUrl, { method: "POST" });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        id: "agent-1",
        organizationId: orgId,
        workspaceId: null,
        scope: "organization",
      });
      expect(mockDb.insert).toHaveBeenCalled();
      expect(mockDb.onConflictDoNothing).toHaveBeenCalled();
    });

    it("returns 404 (no orphan attachment) on a lost promote race", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]);
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]);
      mockDb.limit.mockResolvedValueOnce([
        {
          id: "agent-1",
          providerId: "p1",
          workspaceId,
          skillIds: [],
          subAgentIds: [],
          toolSetIds: [],
        },
      ]);

      mockDb.where
        .mockReturnValueOnce(mockDb) // requireOrgAccess
        .mockReturnValueOnce(mockDb) // requireWorkspaceAccess
        .mockReturnValueOnce(mockDb) // agent lookup
        .mockResolvedValueOnce([
          { id: "p1", name: "Shared Provider", organizationId: orgId },
        ]); // provider validation → OK

      // Transaction update matches no row (already re-scoped) → rollback
      mockDb.returning.mockResolvedValueOnce([]);

      const res = await app.request(promoteUrl, { method: "POST" });
      expect(res.status).toBe(404);
      expect(mockDb.onConflictDoNothing).not.toHaveBeenCalled();
    });
  });
});
