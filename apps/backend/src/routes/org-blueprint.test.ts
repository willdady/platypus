import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockDb, mockSession, resetMockDb } from "../test-utils.ts";
import app from "../server.ts";

describe("Organization Blueprint Routes", () => {
  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
    mockDb.where.mockReturnValue(mockDb);
  });

  const orgId = "org-1";
  const baseUrl = `/organizations/${orgId}/blueprints`;

  describe("POST /", () => {
    const body = {
      name: "Starter kit",
      description: "Provisions the core shared resources.",
      items: [{ resourceType: "agent", resourceId: "agent-1" }],
    };

    it("creates a blueprint when all items are org-scoped (admin)", async () => {
      mockSession();
      const record = {
        id: "bp-1",
        organizationId: orgId,
        name: "Starter kit",
        description: "Provisions the core shared resources.",
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockDb.limit
        .mockResolvedValueOnce([{ role: "admin" }]) // requireOrgAccess
        .mockResolvedValueOnce([record]); // final read-back
      // requireOrgAccess where (chain), then findNonSharedItems where (resolves
      // the org-scoped resources that exist).
      mockDb.where
        .mockReturnValueOnce(mockDb)
        .mockResolvedValueOnce([{ id: "agent-1" }]);

      const res = await app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.id).toBe("bp-1");
      expect(json.items).toEqual([
        { resourceType: "agent", resourceId: "agent-1" },
      ]);
    });

    it("422s when an item is not an org-scoped resource", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]); // requireOrgAccess
      // findNonSharedItems finds nothing for the requested id → invalid.
      mockDb.where.mockReturnValueOnce(mockDb).mockResolvedValueOnce([]);

      const res = await app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(422);
      const json = await res.json();
      expect(json.invalidItems).toEqual([
        { resourceType: "agent", resourceId: "agent-1" },
      ]);
    });

    it("409s on a duplicate blueprint name", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]); // requireOrgAccess
      // Empty items → no validation queries; the blueprint insert conflicts.
      mockDb.insert.mockImplementationOnce(() => {
        throw { code: "23505" };
      });

      const res = await app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify({ name: "Starter kit", items: [] }),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(409);
    });

    it("403s for a non-admin", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess

      const res = await app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(403);
    });
  });

  describe("GET /", () => {
    it("lists blueprints with their items (admin)", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]); // requireOrgAccess
      const blueprints = [
        { id: "bp-1", organizationId: orgId, name: "Starter kit" },
      ];
      const itemRows = [
        { blueprintId: "bp-1", resourceType: "agent", resourceId: "agent-1" },
        { blueprintId: "bp-1", resourceType: "skill", resourceId: "skill-1" },
      ];
      mockDb.where
        .mockReturnValueOnce(mockDb) // requireOrgAccess
        .mockResolvedValueOnce(blueprints) // list blueprints
        .mockResolvedValueOnce(itemRows); // loadItemsByBlueprint

      const res = await app.request(baseUrl);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.results).toHaveLength(1);
      expect(json.results[0].items).toHaveLength(2);
    });

    it("403s for a non-admin", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);

      const res = await app.request(baseUrl);
      expect(res.status).toBe(403);
    });
  });

  describe("GET /:blueprintId", () => {
    it("returns a blueprint with its items", async () => {
      mockSession();
      const record = { id: "bp-1", organizationId: orgId, name: "Starter kit" };
      mockDb.limit
        .mockResolvedValueOnce([{ role: "admin" }]) // requireOrgAccess
        .mockResolvedValueOnce([record]); // blueprint by id
      mockDb.where
        .mockReturnValueOnce(mockDb) // requireOrgAccess
        .mockReturnValueOnce(mockDb) // blueprint by id (chain to limit)
        .mockResolvedValueOnce([
          { blueprintId: "bp-1", resourceType: "agent", resourceId: "agent-1" },
        ]); // loadItemsByBlueprint

      const res = await app.request(`${baseUrl}/bp-1`);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.id).toBe("bp-1");
      expect(json.items).toHaveLength(1);
    });

    it("404s when the blueprint is not in this org", async () => {
      mockSession();
      mockDb.limit
        .mockResolvedValueOnce([{ role: "admin" }]) // requireOrgAccess
        .mockResolvedValueOnce([]); // blueprint by id: not found

      const res = await app.request(`${baseUrl}/missing`);
      expect(res.status).toBe(404);
    });
  });

  describe("PUT /:blueprintId", () => {
    const body = {
      name: "Starter kit v2",
      items: [{ resourceType: "skill", resourceId: "skill-1" }],
    };

    it("replaces the item set (snapshot semantics) and returns the blueprint", async () => {
      mockSession();
      const record = {
        id: "bp-1",
        organizationId: orgId,
        name: "Starter kit v2",
      };
      mockDb.limit
        .mockResolvedValueOnce([{ role: "admin" }]) // requireOrgAccess
        .mockResolvedValueOnce([{ id: "bp-1" }]) // existing blueprint
        .mockResolvedValueOnce([record]); // final read-back
      mockDb.where
        .mockReturnValueOnce(mockDb) // requireOrgAccess
        .mockReturnValueOnce(mockDb) // existing check (chain to limit)
        .mockResolvedValueOnce([{ id: "skill-1" }]); // findNonSharedItems

      const res = await app.request(`${baseUrl}/bp-1`, {
        method: "PUT",
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.items).toEqual([
        { resourceType: "skill", resourceId: "skill-1" },
      ]);
      // The old item set is deleted and re-inserted within the transaction;
      // this never touches existing Attachments on provisioned workspaces.
      expect(mockDb.delete).toHaveBeenCalled();
    });

    it("404s when the blueprint does not exist", async () => {
      mockSession();
      mockDb.limit
        .mockResolvedValueOnce([{ role: "admin" }]) // requireOrgAccess
        .mockResolvedValueOnce([]); // existing check: not found

      const res = await app.request(`${baseUrl}/missing`, {
        method: "PUT",
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(404);
    });

    it("422s when an item is not org-scoped", async () => {
      mockSession();
      mockDb.limit
        .mockResolvedValueOnce([{ role: "admin" }]) // requireOrgAccess
        .mockResolvedValueOnce([{ id: "bp-1" }]); // existing blueprint
      mockDb.where
        .mockReturnValueOnce(mockDb) // requireOrgAccess
        .mockReturnValueOnce(mockDb) // existing check
        .mockResolvedValueOnce([]); // findNonSharedItems: none found

      const res = await app.request(`${baseUrl}/bp-1`, {
        method: "PUT",
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(422);
    });
  });

  describe("DELETE /:blueprintId", () => {
    it("deletes a blueprint (admin)", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]); // requireOrgAccess
      mockDb.returning.mockResolvedValueOnce([{ id: "bp-1" }]);

      const res = await app.request(`${baseUrl}/bp-1`, { method: "DELETE" });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ message: "Blueprint deleted" });
    });

    it("404s when the blueprint does not exist", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]); // requireOrgAccess
      mockDb.returning.mockResolvedValueOnce([]);

      const res = await app.request(`${baseUrl}/missing`, { method: "DELETE" });
      expect(res.status).toBe(404);
    });

    it("403s for a non-admin", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);

      const res = await app.request(`${baseUrl}/bp-1`, { method: "DELETE" });
      expect(res.status).toBe(403);
    });
  });

  describe("POST /:blueprintId/apply", () => {
    const applyUrl = `${baseUrl}/bp-1/apply`;
    const body = { workspaceId: "ws-1" };
    const itemRows = [
      { blueprintId: "bp-1", resourceType: "agent", resourceId: "agent-1" },
      { blueprintId: "bp-1", resourceType: "skill", resourceId: "skill-1" },
    ];

    it("creates the attachments and reports what was attached", async () => {
      mockSession();
      mockDb.limit
        .mockResolvedValueOnce([{ role: "admin" }]) // requireOrgAccess
        .mockResolvedValueOnce([{ id: "bp-1" }]) // blueprint in org
        .mockResolvedValueOnce([{ id: "ws-1" }]); // workspace in org
      mockDb.where
        .mockReturnValueOnce(mockDb) // requireOrgAccess
        .mockReturnValueOnce(mockDb) // blueprint check
        .mockReturnValueOnce(mockDb) // workspace check
        .mockResolvedValueOnce(itemRows); // loadItemsByBlueprint
      // Both items newly inserted.
      mockDb.returning.mockResolvedValueOnce([
        { id: "att-1" },
        { id: "att-2" },
      ]);

      const res = await app.request(applyUrl, {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        workspaceId: "ws-1",
        attached: 2,
        skipped: 0,
        total: 2,
      });
    });

    it("is idempotent: a re-apply where everything is attached is a no-op", async () => {
      mockSession();
      mockDb.limit
        .mockResolvedValueOnce([{ role: "admin" }])
        .mockResolvedValueOnce([{ id: "bp-1" }])
        .mockResolvedValueOnce([{ id: "ws-1" }]);
      mockDb.where
        .mockReturnValueOnce(mockDb)
        .mockReturnValueOnce(mockDb)
        .mockReturnValueOnce(mockDb)
        .mockResolvedValueOnce(itemRows);
      // onConflictDoNothing inserts nothing — all rows already present.
      mockDb.returning.mockResolvedValueOnce([]);

      const res = await app.request(applyUrl, {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        workspaceId: "ws-1",
        attached: 0,
        skipped: 2,
        total: 2,
      });
    });

    it("handles an empty blueprint without inserting", async () => {
      mockSession();
      mockDb.limit
        .mockResolvedValueOnce([{ role: "admin" }])
        .mockResolvedValueOnce([{ id: "bp-1" }])
        .mockResolvedValueOnce([{ id: "ws-1" }]);
      mockDb.where
        .mockReturnValueOnce(mockDb)
        .mockReturnValueOnce(mockDb)
        .mockReturnValueOnce(mockDb)
        .mockResolvedValueOnce([]); // no items

      const res = await app.request(applyUrl, {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        workspaceId: "ws-1",
        attached: 0,
        skipped: 0,
        total: 0,
      });
      expect(mockDb.insert).not.toHaveBeenCalled();
    });

    it("404s when the blueprint is not in this org", async () => {
      mockSession();
      mockDb.limit
        .mockResolvedValueOnce([{ role: "admin" }]) // requireOrgAccess
        .mockResolvedValueOnce([]); // blueprint not found

      const res = await app.request(applyUrl, {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(404);
    });

    it("404s when the workspace is not in this org", async () => {
      mockSession();
      mockDb.limit
        .mockResolvedValueOnce([{ role: "admin" }]) // requireOrgAccess
        .mockResolvedValueOnce([{ id: "bp-1" }]) // blueprint ok
        .mockResolvedValueOnce([]); // workspace not found

      const res = await app.request(applyUrl, {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(404);
    });

    it("403s for a non-admin", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);

      const res = await app.request(applyUrl, {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(403);
    });
  });
});
