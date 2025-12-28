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
      // requireWorkspaceAccess: returns no membership
      mockDb.limit.mockResolvedValueOnce([]);

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
      mockDb.limit.mockResolvedValueOnce([{ role: "editor" }]);

      const mockAgent = { id: "agent-1", name: "New Agent", workspaceId };
      mockDb.returning.mockResolvedValueOnce([mockAgent]);

      const res = await app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify({
          name: "New Agent",
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
  });

  describe("GET /", () => {
    it("should list all agents in workspace", async () => {
      mockSession();
      // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
      // requireWorkspaceAccess
      mockDb.limit.mockResolvedValueOnce([{ role: "viewer" }]);

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
      mockDb.limit.mockResolvedValueOnce([{ role: "viewer" }]);
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
      mockDb.limit.mockResolvedValueOnce([{ role: "viewer" }]);

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
      mockDb.limit.mockResolvedValueOnce([{ role: "editor" }]);

      const mockAgent = { id: "agent-1", name: "Updated Agent" };
      mockDb.returning.mockResolvedValueOnce([mockAgent]);

      const res = await app.request(`${baseUrl}/agent-1`, {
        method: "PUT",
        body: JSON.stringify({
          name: "Updated Agent",
          providerId: "p1",
          modelId: "m1",
        }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([mockAgent]);
    });
  });

  describe("DELETE /:agentId", () => {
    it("should return 403 if user is only editor", async () => {
      mockSession();
      // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
      // requireWorkspaceAccess
      mockDb.limit.mockResolvedValueOnce([{ role: "editor" }]);

      const res = await app.request(`${baseUrl}/agent-1`, {
        method: "DELETE",
      });
      expect(res.status).toBe(403);
    });

    it("should delete agent if user is admin", async () => {
      mockSession();
      // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
      // requireWorkspaceAccess
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]);

      mockDb.where
        .mockReturnValueOnce(mockDb)
        .mockReturnValueOnce(mockDb)
        .mockResolvedValueOnce([]);

      const res = await app.request(`${baseUrl}/agent-1`, {
        method: "DELETE",
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ message: "Agent deleted" });
    });
  });
});
