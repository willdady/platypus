import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockDb, mockSession, resetMockDb } from "../test-utils.ts";
import app from "../server.ts";
import { deleteAvatar } from "../services/avatar.ts";

vi.mock("../services/avatar.ts", () => ({
  storeAvatar: vi.fn(),
  deleteAvatar: vi.fn(),
}));

describe("Organization Agent Routes", () => {
  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
    mockDb.where.mockReturnValue(mockDb);
  });

  const orgId = "org-1";
  const baseUrl = `/organizations/${orgId}/agents`;

  describe("GET /", () => {
    it("lists org agents for any member", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      const agents = [{ id: "agent-1", name: "Shared Agent" }];
      mockDb.where.mockReturnValueOnce(mockDb).mockResolvedValueOnce(agents);

      const res = await app.request(baseUrl);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ results: agents });
    });
  });

  describe("GET /:agentId", () => {
    it("returns an org agent", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      const agent = {
        id: "agent-1",
        name: "Shared Agent",
        organizationId: orgId,
      };
      mockDb.limit.mockResolvedValueOnce([agent]);

      const res = await app.request(`${baseUrl}/agent-1`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(agent);
    });

    it("returns 404 if not found", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([]);

      const res = await app.request(`${baseUrl}/missing`);
      expect(res.status).toBe(404);
    });
  });

  describe("PUT /:agentId", () => {
    it("updates an org agent if org admin and references stay shared", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]); // requireOrgAccess

      mockDb.where
        .mockReturnValueOnce(mockDb) // requireOrgAccess
        .mockResolvedValueOnce([
          { id: "p1", name: "Shared Provider", organizationId: orgId },
        ]); // provider validation → org-scoped

      const updated = {
        id: "agent-1",
        name: "Renamed",
        organizationId: orgId,
      };
      mockDb.returning.mockResolvedValueOnce([updated]);

      const res = await app.request(`${baseUrl}/agent-1`, {
        method: "PUT",
        body: JSON.stringify({
          name: "Renamed",
          description: "A shared agent",
          providerId: "p1",
          modelId: "m1",
        }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(updated);
    });

    it("blocks an update that references a workspace-private resource", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]); // requireOrgAccess

      mockDb.where
        .mockReturnValueOnce(mockDb) // requireOrgAccess
        .mockResolvedValueOnce([
          { id: "p1", name: "WS Provider", organizationId: null },
        ]); // provider validation → workspace-private, blocker

      const res = await app.request(`${baseUrl}/agent-1`, {
        method: "PUT",
        body: JSON.stringify({
          name: "Renamed",
          description: "A shared agent",
          providerId: "p1",
          modelId: "m1",
        }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.blockers).toEqual([
        { type: "provider", id: "p1", name: "WS Provider" },
      ]);
      expect(mockDb.update).not.toHaveBeenCalled();
    });

    it("returns 403 for a non-admin", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess

      const res = await app.request(`${baseUrl}/agent-1`, {
        method: "PUT",
        body: JSON.stringify({
          name: "Renamed",
          description: "A shared agent",
          providerId: "p1",
          modelId: "m1",
        }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(403);
    });
  });

  describe("DELETE /:agentId", () => {
    it("deletes an org agent if org admin and not attached", async () => {
      mockSession();
      mockDb.limit
        .mockResolvedValueOnce([{ role: "admin" }]) // requireOrgAccess
        .mockResolvedValueOnce([]) // attachment guard: none
        .mockResolvedValueOnce([]); // blueprint guard: none
      mockDb.returning.mockResolvedValueOnce([{ id: "agent-1" }]);

      const res = await app.request(`${baseUrl}/agent-1`, { method: "DELETE" });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ message: "Agent deleted" });
    });

    it("removes the deleted agent's avatar from storage", async () => {
      mockSession();
      mockDb.limit
        .mockResolvedValueOnce([{ role: "admin" }]) // requireOrgAccess
        .mockResolvedValueOnce([]) // attachment guard: none
        .mockResolvedValueOnce([]); // blueprint guard: none
      mockDb.returning.mockResolvedValueOnce([
        { id: "agent-1", avatarKey: "agents/agent-1/avatar-x.webp" },
      ]);

      const res = await app.request(`${baseUrl}/agent-1`, { method: "DELETE" });
      expect(res.status).toBe(200);
      expect(deleteAvatar).toHaveBeenCalledWith("agents/agent-1/avatar-x.webp");
    });

    it("returns 409 when the agent is attached to a workspace", async () => {
      mockSession();
      mockDb.limit
        .mockResolvedValueOnce([{ role: "admin" }]) // requireOrgAccess
        .mockResolvedValueOnce([{ id: "att-1" }]); // attachment guard: attached

      const res = await app.request(`${baseUrl}/agent-1`, { method: "DELETE" });
      expect(res.status).toBe(409);
    });

    it("returns 409 when the agent is listed in a blueprint", async () => {
      mockSession();
      mockDb.limit
        .mockResolvedValueOnce([{ role: "admin" }]) // requireOrgAccess
        .mockResolvedValueOnce([]) // attachment guard: none
        .mockResolvedValueOnce([{ id: "bpi-1" }]); // blueprint guard: listed

      const res = await app.request(`${baseUrl}/agent-1`, { method: "DELETE" });
      expect(res.status).toBe(409);
    });

    it("returns 403 for a non-admin", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess

      const res = await app.request(`${baseUrl}/agent-1`, { method: "DELETE" });
      expect(res.status).toBe(403);
    });
  });

  describe("avatar routes", () => {
    it("POST avatar returns 403 for a non-admin", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess

      const res = await app.request(`${baseUrl}/agent-1/avatar`, {
        method: "POST",
      });
      expect(res.status).toBe(403);
    });

    it("POST avatar 404s when the org agent does not exist", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([]); // agent lookup → none

      const res = await app.request(`${baseUrl}/agent-1/avatar`, {
        method: "POST",
      });
      expect(res.status).toBe(404);
    });

    it("DELETE avatar clears the avatar for an org admin", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ avatarKey: null }]); // agent lookup
      mockDb.returning.mockResolvedValueOnce([
        { id: "agent-1", avatarKey: null },
      ]);

      const res = await app.request(`${baseUrl}/agent-1/avatar`, {
        method: "DELETE",
      });
      expect(res.status).toBe(200);
    });

    it("DELETE avatar 404s when the org agent does not exist", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([]); // agent lookup → none

      const res = await app.request(`${baseUrl}/agent-1/avatar`, {
        method: "DELETE",
      });
      expect(res.status).toBe(404);
    });
  });
});
