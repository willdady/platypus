import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  mockDb,
  mockSession,
  mockNoSession,
  resetMockDb,
} from "../test-utils.ts";

vi.mock("../services/sub-agent-validation.ts", () => ({
  validateSubAgentAssignment: vi.fn().mockResolvedValue({ valid: true }),
}));

import app from "../server.ts";
import { validateSubAgentAssignment } from "../services/sub-agent-validation.ts";

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
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "other-user" }]);

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
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]);

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
      // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
      // requireWorkspaceAccess
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]);

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
      const body = await res.json();
      expect(body.success).toBe(false);
      expect(Array.isArray(body.error)).toBe(true);
      expect(body.error[0].code).toBe("too_big");
      expect(body.error[0].path).toContain("description");
    });
  });

  describe("GET /", () => {
    it("should list all agents in workspace", async () => {
      mockSession();
      // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
      // requireWorkspaceAccess
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]);

      const mockAgents = [{ id: "agent-1", name: "Agent 1" }];
      mockDb.where
        .mockReturnValueOnce(mockDb)
        .mockReturnValueOnce(mockDb)
        .mockResolvedValueOnce(mockAgents);

      const res = await app.request(baseUrl);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ results: mockAgents });
    });
  });

  describe("GET /:agentId", () => {
    it("should return 404 if agent not found", async () => {
      mockSession();
      // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
      // requireWorkspaceAccess
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]);
      // get agent
      mockDb.limit.mockResolvedValueOnce([]);

      const res = await app.request(`${baseUrl}/agent-1`);
      expect(res.status).toBe(404);
    });

    it("should return agent if found", async () => {
      mockSession();
      // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
      // requireWorkspaceAccess
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]);

      const mockAgent = { id: "agent-1", name: "Agent 1" };
      mockDb.limit.mockResolvedValueOnce([mockAgent]);

      const res = await app.request(`${baseUrl}/agent-1`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(mockAgent);
    });
  });

  describe("PUT /:agentId", () => {
    it("should update agent if user is editor", async () => {
      mockSession();
      // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
      // requireWorkspaceAccess
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]);

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

    it("should return 400 if description is too long on update", async () => {
      mockSession();
      // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
      // requireWorkspaceAccess
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]);

      const longDescription = "a".repeat(129);

      const res = await app.request(`${baseUrl}/agent-1`, {
        method: "PUT",
        body: JSON.stringify({
          name: "Updated Agent",
          providerId: "p1",
          modelId: "m1",
          description: longDescription,
        }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.success).toBe(false);
      expect(Array.isArray(body.error)).toBe(true);
      expect(body.error[0].code).toBe("too_big");
      expect(body.error[0].path).toContain("description");
    });
  });

  describe("subAgentIds dedup", () => {
    it("deduplicates duplicate sub-agent ids on POST, keeping the last entry's parentOutput", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]);
      mockDb.returning.mockResolvedValueOnce([{ id: "agent-1" }]);

      const res = await app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify({
          name: "Coord Agent",
          description: "test",
          providerId: "p1",
          modelId: "m1",
          workspaceId,
          subAgentIds: [
            { id: "sa-1" },
            { id: "sa-1", parentOutput: "none" },
            { id: "sa-2", parentOutput: "500" },
          ],
        }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(201);
      // The last entry for sa-1 wins (parentOutput: "none"); sa-2 unchanged
      expect(validateSubAgentAssignment).toHaveBeenCalledWith(workspaceId, "", [
        { id: "sa-1", parentOutput: "none" },
        { id: "sa-2", parentOutput: "500" },
      ]);
      expect(mockDb.values).toHaveBeenCalledWith(
        expect.objectContaining({
          subAgentIds: [
            { id: "sa-1", parentOutput: "none" },
            { id: "sa-2", parentOutput: "500" },
          ],
        }),
      );
    });

    it("deduplicates duplicate sub-agent ids on PUT", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]);
      mockDb.returning.mockResolvedValueOnce([{ id: "agent-1" }]);

      await app.request(`${baseUrl}/agent-1`, {
        method: "PUT",
        body: JSON.stringify({
          name: "Updated",
          description: "test",
          providerId: "p1",
          modelId: "m1",
          subAgentIds: [{ id: "sa-1" }, { id: "sa-1", parentOutput: "full" }],
        }),
        headers: { "Content-Type": "application/json" },
      });

      expect(mockDb.set).toHaveBeenCalledWith(
        expect.objectContaining({
          subAgentIds: [{ id: "sa-1", parentOutput: "full" }],
        }),
      );
    });

    it("rejects POST with 400 when validation fails", async () => {
      vi.mocked(validateSubAgentAssignment).mockResolvedValueOnce({
        valid: false,
        error: "An agent cannot assign itself as a sub-agent",
      });
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]);

      const res = await app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify({
          name: "Bad Agent",
          description: "test",
          providerId: "p1",
          modelId: "m1",
          workspaceId,
          subAgentIds: [{ id: "self" }],
        }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(400);
    });
  });

  describe("DELETE /:agentId", () => {
    it("should delete agent if user is workspace owner", async () => {
      mockSession();
      // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
      // requireWorkspaceAccess
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]);
      // Avatar lookup (agent has no avatar)
      mockDb.limit.mockResolvedValueOnce([{ avatarKey: null }]);

      const res = await app.request(`${baseUrl}/agent-1`, {
        method: "DELETE",
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ message: "Agent deleted" });
    });
  });
});
