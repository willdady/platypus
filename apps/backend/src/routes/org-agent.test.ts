import { describe, it, expect, beforeEach, vi } from "vitest";
// test-utils installs the drizzle-orm mock, whose operators return comparable
// markers — so a route's `WHERE` can be asserted against `orgScopedWhere`.
import { mockDb, mockSession, resetMockDb } from "../test-utils.ts";
import { orgScopedWhere } from "../services/scoped-resource.ts";
import app from "../server.ts";
import { deleteAvatar, storeAvatar } from "../services/avatar.ts";

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
      mockDb.limit
        .mockResolvedValueOnce([{ role: "admin" }]) // requireOrgAccess
        .mockResolvedValueOnce([
          { id: "agent-1", organizationId: orgId, workspaceId: null },
        ]); // requireOrgScoped

      mockDb.where
        .mockReturnValueOnce(mockDb) // requireOrgAccess
        .mockReturnValueOnce(mockDb) // requireOrgScoped
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
      // The write matches the Shared predicate, not `organizationId` alone: a
      // row carrying both scope columns belongs to its Workspace and must not
      // be editable from the Organization surface (ADR-0007).
      expect(mockDb.where).toHaveBeenLastCalledWith(
        orgScopedWhere("agent", "agent-1", orgId),
      );
    });

    it("blocks an update that references a workspace-private resource", async () => {
      mockSession();
      mockDb.limit
        .mockResolvedValueOnce([{ role: "admin" }]) // requireOrgAccess
        .mockResolvedValueOnce([
          { id: "agent-1", organizationId: orgId, workspaceId: null },
        ]); // requireOrgScoped

      mockDb.where
        .mockReturnValueOnce(mockDb) // requireOrgAccess
        .mockReturnValueOnce(mockDb) // requireOrgScoped
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
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.blockers).toEqual([
        { type: "provider", id: "p1", name: "WS Provider" },
      ]);
      expect(mockDb.update).not.toHaveBeenCalled();
    });

    it("returns 404 when the agent is not visible here", async () => {
      mockSession();
      mockDb.limit
        .mockResolvedValueOnce([{ role: "admin" }]) // requireOrgAccess
        .mockResolvedValueOnce([]); // requireOrgScoped: not found

      mockDb.where.mockReturnValueOnce(mockDb); // requireOrgAccess

      const res = await app.request(`${baseUrl}/missing`, {
        method: "PUT",
        body: JSON.stringify({
          name: "Renamed",
          description: "A shared agent",
          providerId: "p1",
          modelId: "m1",
        }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(404);
    });

    it("rejects a self-assigned sub-agent", async () => {
      mockSession();
      mockDb.limit
        .mockResolvedValueOnce([{ role: "admin" }]) // requireOrgAccess
        .mockResolvedValueOnce([
          { id: "agent-1", organizationId: orgId, workspaceId: null },
        ]); // requireOrgScoped

      mockDb.where.mockReturnValueOnce(mockDb); // requireOrgAccess

      const res = await app.request(`${baseUrl}/agent-1`, {
        method: "PUT",
        body: JSON.stringify({
          name: "Renamed",
          description: "A shared agent",
          providerId: "p1",
          modelId: "m1",
          subAgentIds: ["agent-1"],
        }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(400);
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

    const upload = () => {
      const form = new FormData();
      form.append("file", new File(["x"], "a.png", { type: "image/png" }));
      return app.request(`${baseUrl}/agent-1/avatar`, {
        method: "POST",
        body: form,
      });
    };

    it("POST avatar stores the upload and persists its key on the Shared agent", async () => {
      mockSession();
      mockDb.limit
        .mockResolvedValueOnce([{ role: "admin" }]) // requireOrgAccess
        .mockResolvedValueOnce([{ id: "agent-1", avatarKey: "old" }]); // agent lookup
      vi.mocked(storeAvatar).mockResolvedValueOnce({ ok: true, key: "new" });
      mockDb.returning.mockResolvedValueOnce([
        { id: "agent-1", avatarKey: "new" },
      ]);

      const res = await upload();

      expect(res.status).toBe(200);
      expect(storeAvatar).toHaveBeenCalledWith(
        expect.any(File),
        "agent-1",
        "old",
      );
      expect(mockDb.set).toHaveBeenCalledWith(
        expect.objectContaining({ avatarKey: "new" }),
      );
      // The write matches the Shared predicate (ADR-0007), as PUT does.
      expect(mockDb.where).toHaveBeenLastCalledWith(
        orgScopedWhere("agent", "agent-1", orgId),
      );
    });

    it("POST avatar returns 400 when the upload is rejected", async () => {
      mockSession();
      mockDb.limit
        .mockResolvedValueOnce([{ role: "admin" }]) // requireOrgAccess
        .mockResolvedValueOnce([{ id: "agent-1", avatarKey: null }]); // agent lookup
      vi.mocked(storeAvatar).mockResolvedValueOnce({
        ok: false,
        error: "Invalid file type",
      });

      const res = await upload();

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "Invalid file type" });
      expect(mockDb.update).not.toHaveBeenCalled();
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
      expect(mockDb.set).toHaveBeenCalledWith(
        expect.objectContaining({ avatarKey: null }),
      );
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
