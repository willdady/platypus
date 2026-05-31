import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockDb, mockSession, resetMockDb } from "../test-utils.ts";
import app from "../server.ts";

describe("Attachment Routes", () => {
  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
    mockDb.where.mockReturnValue(mockDb);
  });

  const orgId = "org-1";
  const workspaceId = "ws-1";
  const baseUrl = `/organizations/${orgId}/workspaces/${workspaceId}/attachments`;
  const workspace = {
    id: workspaceId,
    ownerId: "owner-1",
    organizationId: orgId,
  };

  /** Mocks the two middleware lookups: org membership, then workspace fetch. */
  const mockAdminAccess = () => {
    mockSession();
    mockDb.limit
      .mockResolvedValueOnce([{ role: "admin" }]) // requireOrgAccess
      .mockResolvedValueOnce([workspace]); // requireWorkspaceAccess
  };

  describe("POST /", () => {
    it("attaches an org-scoped resource for an admin", async () => {
      mockAdminAccess();
      mockDb.limit.mockResolvedValueOnce([{ id: "mcp-1" }]); // org-scope lookup
      const record = {
        id: "att-1",
        workspaceId,
        resourceType: "mcp",
        resourceId: "mcp-1",
      };
      mockDb.returning.mockResolvedValueOnce([record]);

      const res = await app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify({ resourceType: "mcp", resourceId: "mcp-1" }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(201);
      expect(await res.json()).toEqual(record);
    });

    it("returns 403 for a non-admin", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess

      const res = await app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify({ resourceType: "mcp", resourceId: "mcp-1" }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(403);
    });

    it("returns 404 when the resource is not org-scoped in this org", async () => {
      mockAdminAccess();
      mockDb.limit.mockResolvedValueOnce([]); // org-scope lookup miss

      const res = await app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify({ resourceType: "provider", resourceId: "p-x" }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(404);
    });

    it("returns 409 when already attached", async () => {
      mockAdminAccess();
      mockDb.limit.mockResolvedValueOnce([{ id: "mcp-1" }]); // org-scope lookup

      const err = new Error("DrizzleQueryError");
      (err as any).cause = {
        code: "23505",
        message:
          'duplicate key value violates unique constraint "unique_attachment"',
      };
      mockDb.returning.mockRejectedValueOnce(err);

      const res = await app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify({ resourceType: "mcp", resourceId: "mcp-1" }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(409);
    });
  });

  describe("DELETE /:resourceType/:resourceId", () => {
    it("detaches a resource for an admin", async () => {
      mockAdminAccess();
      mockDb.returning.mockResolvedValueOnce([{ id: "att-1" }]);

      const res = await app.request(`${baseUrl}/mcp/mcp-1`, {
        method: "DELETE",
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ message: "Detached" });
    });

    it("returns 404 when no attachment exists", async () => {
      mockAdminAccess();
      mockDb.returning.mockResolvedValueOnce([]);

      const res = await app.request(`${baseUrl}/mcp/mcp-1`, {
        method: "DELETE",
      });
      expect(res.status).toBe(404);
    });

    it("returns 403 for a non-admin", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess

      const res = await app.request(`${baseUrl}/mcp/mcp-1`, {
        method: "DELETE",
      });
      expect(res.status).toBe(403);
    });
  });

  describe("GET /", () => {
    it("lists attachments for the workspace", async () => {
      mockAdminAccess();
      const rows = [
        { id: "att-1", workspaceId, resourceType: "mcp", resourceId: "mcp-1" },
      ];
      // requireOrgAccess + requireWorkspaceAccess consume two `where`s, route the third
      mockDb.where
        .mockReturnValueOnce(mockDb)
        .mockReturnValueOnce(mockDb)
        .mockResolvedValueOnce(rows);

      const res = await app.request(baseUrl);
      expect(res.status).toBe(200);
      expect((await res.json()).results).toEqual(rows);
    });
  });
});
