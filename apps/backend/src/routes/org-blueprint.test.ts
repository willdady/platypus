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

    // ADR-0008 Tier 2: a Blueprint can carry Workspace pointer-settings, but a
    // Tier 2 provider must be one the blueprint also attaches.
    it("persists Tier 2 settings when the provider is also an attached item", async () => {
      mockSession();
      const record = {
        id: "bp-1",
        organizationId: orgId,
        name: "Starter kit",
        taskModelProviderId: "prov-1",
        context: "Default context",
      };
      mockDb.limit
        .mockResolvedValueOnce([{ role: "admin" }]) // requireOrgAccess
        .mockResolvedValueOnce([record]); // final read-back
      mockDb.where
        .mockReturnValueOnce(mockDb) // requireOrgAccess
        .mockResolvedValueOnce([{ id: "prov-1" }]); // findNonSharedItems (provider)

      const res = await app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify({
          name: "Starter kit",
          // The Tier 2 provider is attached as a Tier 1 item.
          items: [{ resourceType: "provider", resourceId: "prov-1" }],
          taskModelProviderId: "prov-1",
          context: "Default context",
        }),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.taskModelProviderId).toBe("prov-1");
      expect(json.context).toBe("Default context");
    });

    it("422s when a Tier 2 provider is not attached by the blueprint", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]); // requireOrgAccess
      // Empty items → no item query; the Tier 2 provider is not attached.

      const res = await app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify({
          name: "Starter kit",
          items: [],
          memoryEmbeddingProviderId: "prov-x",
        }),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(422);
      expect((await res.json()).invalidProviderIds).toEqual(["prov-x"]);
    });

    // Parity with the workspace route: a memory provider must expose the model
    // its slot needs, so apply never stamps an unusable memory config.
    it("422s when the memory embedding provider has no embedding model", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]); // requireOrgAccess
      mockDb.where
        .mockReturnValueOnce(mockDb) // requireOrgAccess
        .mockResolvedValueOnce([{ id: "prov-1" }]) // findNonSharedItems (provider attached)
        .mockResolvedValueOnce([
          {
            id: "prov-1",
            memoryExtractionModelId: "m",
            embeddingModelId: null,
          },
        ]); // findInvalidMemoryProviders

      const res = await app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify({
          name: "Starter kit",
          items: [{ resourceType: "provider", resourceId: "prov-1" }],
          memoryEmbeddingProviderId: "prov-1",
        }),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(422);
      const json = await res.json();
      expect(json.invalidMemoryProviders).toEqual([
        expect.objectContaining({
          field: "memoryEmbeddingProviderId",
          providerId: "prov-1",
        }),
      ]);
    });

    it("creates when the memory embedding provider has an embedding model", async () => {
      mockSession();
      const record = {
        id: "bp-1",
        organizationId: orgId,
        name: "Starter kit",
        memoryEmbeddingProviderId: "prov-1",
      };
      mockDb.limit
        .mockResolvedValueOnce([{ role: "admin" }]) // requireOrgAccess
        .mockResolvedValueOnce([record]); // read-back
      mockDb.where
        .mockReturnValueOnce(mockDb) // requireOrgAccess
        .mockResolvedValueOnce([{ id: "prov-1" }]) // findNonSharedItems
        .mockResolvedValueOnce([
          {
            id: "prov-1",
            memoryExtractionModelId: "m",
            embeddingModelId: "emb-model",
          },
        ]); // findInvalidMemoryProviders: valid

      const res = await app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify({
          name: "Starter kit",
          items: [{ resourceType: "provider", resourceId: "prov-1" }],
          memoryEmbeddingProviderId: "prov-1",
        }),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(201);
      expect((await res.json()).memoryEmbeddingProviderId).toBe("prov-1");
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
    it("deletes a blueprint (admin) when no live invitation references it", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]); // requireOrgAccess
      // Deletion guard: no pending invitations reference this blueprint.
      mockDb.where.mockReturnValueOnce(mockDb).mockResolvedValueOnce([]);
      mockDb.returning.mockResolvedValueOnce([{ id: "bp-1" }]);

      const res = await app.request(`${baseUrl}/bp-1`, { method: "DELETE" });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ message: "Blueprint deleted" });
    });

    it("404s when the blueprint does not exist", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]); // requireOrgAccess
      mockDb.where.mockReturnValueOnce(mockDb).mockResolvedValueOnce([]); // guard: clear
      mockDb.returning.mockResolvedValueOnce([]);

      const res = await app.request(`${baseUrl}/missing`, { method: "DELETE" });
      expect(res.status).toBe(404);
    });

    // ADR-0009: a Blueprint cannot be deleted while a live pending invitation
    // references it (status = 'pending' AND expiresAt > now()).
    it("409s when a live pending invitation references the blueprint", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]); // requireOrgAccess
      const future = new Date();
      future.setDate(future.getDate() + 7);
      // Guard query returns a still-live pending invitation.
      mockDb.where
        .mockReturnValueOnce(mockDb)
        .mockResolvedValueOnce([{ expiresAt: future.toISOString() }]);

      const res = await app.request(`${baseUrl}/bp-1`, { method: "DELETE" });
      expect(res.status).toBe(409);
      // The delete must not run while the guard blocks.
      expect(mockDb.delete).not.toHaveBeenCalled();
    });

    // Expiry is lazy with write-back: a row past expiresAt may still read
    // 'pending'. The guard excludes it in app code, so deletion proceeds.
    it("allows deletion when the only referencing invitation is lazily-expired", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]); // requireOrgAccess
      const past = new Date();
      past.setDate(past.getDate() - 1);
      mockDb.where
        .mockReturnValueOnce(mockDb)
        .mockResolvedValueOnce([{ expiresAt: past.toISOString() }]);
      mockDb.returning.mockResolvedValueOnce([{ id: "bp-1" }]);

      const res = await app.request(`${baseUrl}/bp-1`, { method: "DELETE" });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ message: "Blueprint deleted" });
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
      { resourceType: "agent", resourceId: "agent-1" },
      { resourceType: "skill", resourceId: "skill-1" },
    ];
    // Tier 2 source row for bp-1 (the apply service reads these settings).
    const tier2Rows = [
      {
        id: "bp-1",
        taskModelProviderId: "prov-1",
        memoryExtractionProviderId: null,
        memoryEmbeddingProviderId: null,
        context: "Default context",
      },
    ];

    // The apply service (inside the route's transaction) runs two selects —
    // Tier 2 settings then items — so the where mocks resolve in that order
    // after the route's blueprint/workspace org checks.
    it("creates the attachments and stamps Tier 2 settings", async () => {
      mockSession();
      mockDb.limit
        .mockResolvedValueOnce([{ role: "admin" }]) // requireOrgAccess
        .mockResolvedValueOnce([{ id: "bp-1" }]) // blueprint in org
        .mockResolvedValueOnce([{ id: "ws-1" }]); // workspace in org
      mockDb.where
        .mockReturnValueOnce(mockDb) // requireOrgAccess
        .mockReturnValueOnce(mockDb) // blueprint check
        .mockReturnValueOnce(mockDb) // workspace check
        .mockResolvedValueOnce(tier2Rows) // service: Tier 2 select
        .mockResolvedValueOnce(itemRows); // service: items select
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
      // Tier 2: the workspace is updated with the blueprint's non-null slots.
      const tier2Set = mockDb.set.mock.calls
        .map((c) => c[0])
        .find((v) => v?.taskModelProviderId !== undefined);
      expect(tier2Set).toMatchObject({
        taskModelProviderId: "prov-1",
        context: "Default context",
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
        .mockResolvedValueOnce(tier2Rows) // Tier 2 select
        .mockResolvedValueOnce(itemRows); // items select
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

    it("handles an empty blueprint without inserting attachments", async () => {
      mockSession();
      mockDb.limit
        .mockResolvedValueOnce([{ role: "admin" }])
        .mockResolvedValueOnce([{ id: "bp-1" }])
        .mockResolvedValueOnce([{ id: "ws-1" }]);
      mockDb.where
        .mockReturnValueOnce(mockDb)
        .mockReturnValueOnce(mockDb)
        .mockReturnValueOnce(mockDb)
        .mockResolvedValueOnce([
          {
            id: "bp-1",
            taskModelProviderId: null,
            memoryExtractionProviderId: null,
            memoryEmbeddingProviderId: null,
            context: null,
          },
        ]) // Tier 2 select: nothing set
        .mockResolvedValueOnce([]); // items select: no items

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
