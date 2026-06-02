import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockDb, mockSession, resetMockDb } from "../test-utils.ts";
import app from "../server.ts";

describe("Organization Attachment (central sharing) Routes", () => {
  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
    mockDb.where.mockReturnValue(mockDb);
  });

  const orgId = "org-1";
  const baseUrl = `/organizations/${orgId}/attachments`;

  describe("GET /", () => {
    it("lists the workspaces a shared resource is attached to", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]); // requireOrgAccess
      const rows = [
        { workspaceId: "ws-1", workspaceName: "Alpha", createdAt: new Date() },
        { workspaceId: "ws-2", workspaceName: "Beta", createdAt: new Date() },
      ];
      mockDb.where.mockReturnValueOnce(mockDb).mockResolvedValueOnce(rows);

      const res = await app.request(
        `${baseUrl}?resourceType=agent&resourceId=agent-1`,
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.results).toHaveLength(2);
      expect(body.results[0].workspaceName).toBe("Alpha");
    });

    it("returns 400 without resourceType/resourceId", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]);

      const res = await app.request(baseUrl);
      expect(res.status).toBe(400);
    });

    it("returns 403 for a non-admin", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);

      const res = await app.request(
        `${baseUrl}?resourceType=agent&resourceId=agent-1`,
      );
      expect(res.status).toBe(403);
    });
  });

  describe("POST /", () => {
    const body = {
      resourceType: "agent",
      resourceId: "agent-1",
      workspaceId: "ws-1",
    };

    it("attaches a shared resource to a workspace", async () => {
      mockSession();
      mockDb.limit
        .mockResolvedValueOnce([{ role: "admin" }]) // requireOrgAccess
        .mockResolvedValueOnce([{ id: "ws-1" }]) // workspace belongs to org
        .mockResolvedValueOnce([{ id: "agent-1" }]); // org-scoped resource exists
      const att = {
        id: "att-1",
        workspaceId: "ws-1",
        resourceType: "agent",
        resourceId: "agent-1",
      };
      mockDb.returning.mockResolvedValueOnce([att]);

      const res = await app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(201);
      expect(await res.json()).toEqual(att);
    });

    it("404s when the workspace is not in this org", async () => {
      mockSession();
      mockDb.limit
        .mockResolvedValueOnce([{ role: "admin" }])
        .mockResolvedValueOnce([]); // workspace not found in org

      const res = await app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(404);
    });

    it("404s when the resource is not an org-scoped resource in this org", async () => {
      mockSession();
      mockDb.limit
        .mockResolvedValueOnce([{ role: "admin" }])
        .mockResolvedValueOnce([{ id: "ws-1" }]) // workspace ok
        .mockResolvedValueOnce([]); // resource not org-scoped here

      const res = await app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(404);
    });

    it("returns 403 for a non-admin", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);

      const res = await app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(403);
    });
  });

  describe("DELETE /:resourceType/:resourceId/:workspaceId", () => {
    const delUrl = `${baseUrl}/agent/agent-1/ws-1`;

    it("detaches a shared resource from a workspace", async () => {
      mockSession();
      mockDb.limit
        .mockResolvedValueOnce([{ role: "admin" }]) // requireOrgAccess
        .mockResolvedValueOnce([{ id: "ws-1" }]); // workspace in org
      mockDb.returning.mockResolvedValueOnce([{ id: "att-1" }]);

      const res = await app.request(delUrl, { method: "DELETE" });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ message: "Detached" });
    });

    it("404s when no such attachment exists", async () => {
      mockSession();
      mockDb.limit
        .mockResolvedValueOnce([{ role: "admin" }])
        .mockResolvedValueOnce([{ id: "ws-1" }]);
      mockDb.returning.mockResolvedValueOnce([]); // nothing deleted

      const res = await app.request(delUrl, { method: "DELETE" });
      expect(res.status).toBe(404);
    });

    it("returns 403 for a non-admin", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);

      const res = await app.request(delUrl, { method: "DELETE" });
      expect(res.status).toBe(403);
    });
  });
});
