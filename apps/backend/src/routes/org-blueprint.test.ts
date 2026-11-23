import { describe, it, expect, beforeEach, vi } from "vitest";
import { dbError, mockDb, mockSession, resetMockDb } from "../test-utils.ts";
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
        .mockResolvedValueOnce([{ role: "admin" }])
        .mockResolvedValueOnce([record]);
      mockDb.where
        .mockReturnValueOnce(mockDb)
        .mockResolvedValueOnce([{ id: "agent-1" }]);

      const res = await app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(201);
      const json = (await res.json()) as Record<string, unknown>;
      expect(json.id).toBe("bp-1");
      expect(json.items).toEqual([
        { resourceType: "agent", resourceId: "agent-1" },
      ]);
    });

    it("404s when an item is not an org-scoped resource", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]);
      mockDb.where.mockReturnValueOnce(mockDb).mockResolvedValueOnce([]);

      const res = await app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({
        error: "Shared resources not found in this organization: agent agent-1",
      });
    });

    it("409s on a duplicate blueprint name", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]);
      mockDb.insert.mockImplementationOnce(() => {
        throw dbError("23505");
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
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);

      const res = await app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(403);
    });

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
        .mockResolvedValueOnce([{ role: "admin" }])
        .mockResolvedValueOnce([record]);
      mockDb.where
        .mockReturnValueOnce(mockDb)
        .mockResolvedValueOnce([{ id: "prov-1" }]);

      const res = await app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify({
          name: "Starter kit",
          items: [{ resourceType: "provider", resourceId: "prov-1" }],
          taskModelProviderId: "prov-1",
          context: "Default context",
        }),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(201);
      const json = (await res.json()) as Record<string, unknown>;
      expect(json.taskModelProviderId).toBe("prov-1");
      expect(json.context).toBe("Default context");
    });

    it("400s, naming it, when a Tier 2 provider is not attached by the blueprint", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]);

      const res = await app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify({
          name: "Starter kit",
          items: [],
          memoryEmbeddingProviderId: "prov-x",
        }),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error:
          "A blueprint's provider settings must reference providers the blueprint also attaches: prov-x",
      });
    });

    it("400s, naming it, when the memory embedding provider has no embedding model", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]);
      mockDb.where
        .mockReturnValueOnce(mockDb)
        .mockResolvedValueOnce([{ id: "prov-1" }])
        .mockResolvedValueOnce([
          {
            id: "prov-1",
            memoryExtractionModelId: "m",
            embeddingModelId: null,
          },
        ]);

      const res = await app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify({
          name: "Starter kit",
          items: [{ resourceType: "provider", resourceId: "prov-1" }],
          memoryEmbeddingProviderId: "prov-1",
        }),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error:
          "Invalid memory provider settings: memoryEmbeddingProviderId prov-1 does not have an embedding model configured",
      });
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
        .mockResolvedValueOnce([{ role: "admin" }])
        .mockResolvedValueOnce([record]);
      mockDb.where
        .mockReturnValueOnce(mockDb)
        .mockResolvedValueOnce([{ id: "prov-1" }])
        .mockResolvedValueOnce([
          {
            id: "prov-1",
            memoryExtractionModelId: "m",
            embeddingModelId: "emb-model",
          },
        ]);

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
      expect(
        ((await res.json()) as { memoryEmbeddingProviderId: string })
          .memoryEmbeddingProviderId,
      ).toBe("prov-1");
    });
  });

  describe("GET /", () => {
    it("lists blueprints with their items (admin)", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]);
      const blueprints = [
        { id: "bp-1", organizationId: orgId, name: "Starter kit" },
      ];
      const itemRows = [
        { blueprintId: "bp-1", resourceType: "agent", resourceId: "agent-1" },
        { blueprintId: "bp-1", resourceType: "skill", resourceId: "skill-1" },
      ];
      mockDb.where
        .mockReturnValueOnce(mockDb)
        .mockResolvedValueOnce(blueprints)
        .mockResolvedValueOnce(itemRows);

      const res = await app.request(baseUrl);
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        results: { items: unknown[] }[];
      };
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
        .mockResolvedValueOnce([{ role: "admin" }])
        .mockResolvedValueOnce([record]);
      mockDb.where
        .mockReturnValueOnce(mockDb)
        .mockReturnValueOnce(mockDb)
        .mockResolvedValueOnce([
          { blueprintId: "bp-1", resourceType: "agent", resourceId: "agent-1" },
        ]);

      const res = await app.request(`${baseUrl}/bp-1`);
      expect(res.status).toBe(200);
      const json = (await res.json()) as Record<string, unknown>;
      expect(json.id).toBe("bp-1");
      expect(json.items).toHaveLength(1);
    });

    it("404s when the blueprint is not in this org", async () => {
      mockSession();
      mockDb.limit
        .mockResolvedValueOnce([{ role: "admin" }])
        .mockResolvedValueOnce([]);

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
        .mockResolvedValueOnce([{ role: "admin" }])
        .mockResolvedValueOnce([{ id: "bp-1" }])
        .mockResolvedValueOnce([record]);
      mockDb.where
        .mockReturnValueOnce(mockDb)
        .mockReturnValueOnce(mockDb)
        .mockResolvedValueOnce([{ id: "skill-1" }]);

      const res = await app.request(`${baseUrl}/bp-1`, {
        method: "PUT",
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as Record<string, unknown>;
      expect(json.items).toEqual([
        { resourceType: "skill", resourceId: "skill-1" },
      ]);
      expect(mockDb.delete).toHaveBeenCalled();
    });

    it("404s when the blueprint does not exist", async () => {
      mockSession();
      mockDb.limit
        .mockResolvedValueOnce([{ role: "admin" }])
        .mockResolvedValueOnce([]);

      const res = await app.request(`${baseUrl}/missing`, {
        method: "PUT",
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(404);
    });

    it("404s when an item is not org-scoped", async () => {
      mockSession();
      mockDb.limit
        .mockResolvedValueOnce([{ role: "admin" }])
        .mockResolvedValueOnce([{ id: "bp-1" }]);
      mockDb.where
        .mockReturnValueOnce(mockDb)
        .mockReturnValueOnce(mockDb)
        .mockResolvedValueOnce([]);

      const res = await app.request(`${baseUrl}/bp-1`, {
        method: "PUT",
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({
        error: "Shared resources not found in this organization: skill skill-1",
      });
    });

    it("409s when renamed to another blueprint's name", async () => {
      mockSession();
      mockDb.limit
        .mockResolvedValueOnce([{ role: "admin" }])
        .mockResolvedValueOnce([{ id: "bp-1" }]);
      mockDb.transaction.mockImplementationOnce(() => {
        throw dbError("23505");
      });

      const res = await app.request(`${baseUrl}/bp-1`, {
        method: "PUT",
        body: JSON.stringify({ name: "Taken", items: [] }),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(409);
    });

    it("400s, naming it, when a Tier 2 provider is not attached by the blueprint", async () => {
      mockSession();
      mockDb.limit
        .mockResolvedValueOnce([{ role: "admin" }])
        .mockResolvedValueOnce([{ id: "bp-1" }]);

      const res = await app.request(`${baseUrl}/bp-1`, {
        method: "PUT",
        body: JSON.stringify({
          name: "Starter kit v2",
          items: [],
          taskModelProviderId: "prov-1",
        }),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error:
          "A blueprint's provider settings must reference providers the blueprint also attaches: prov-1",
      });
      expect(mockDb.transaction).not.toHaveBeenCalled();
    });

    it("403s for a non-admin", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);

      const res = await app.request(`${baseUrl}/bp-1`, {
        method: "PUT",
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(403);
      expect(mockDb.transaction).not.toHaveBeenCalled();
    });
  });

  describe("DELETE /:blueprintId", () => {
    it("deletes a blueprint (admin) when no live invitation references it", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]);
      mockDb.where.mockReturnValueOnce(mockDb).mockResolvedValueOnce([]);
      mockDb.returning.mockResolvedValueOnce([{ id: "bp-1" }]);

      const res = await app.request(`${baseUrl}/bp-1`, { method: "DELETE" });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ message: "Blueprint deleted" });
    });

    it("404s when the blueprint does not exist", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]);
      mockDb.where.mockReturnValueOnce(mockDb).mockResolvedValueOnce([]);
      mockDb.returning.mockResolvedValueOnce([]);

      const res = await app.request(`${baseUrl}/missing`, { method: "DELETE" });
      expect(res.status).toBe(404);
    });

    it("409s when a live pending invitation references the blueprint", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]);
      const future = new Date();
      future.setDate(future.getDate() + 7);
      mockDb.where
        .mockReturnValueOnce(mockDb)
        .mockResolvedValueOnce([{ expiresAt: future.toISOString() }]);

      const res = await app.request(`${baseUrl}/bp-1`, { method: "DELETE" });
      expect(res.status).toBe(409);
      expect(mockDb.delete).not.toHaveBeenCalled();
    });

    it("allows deletion when the only referencing invitation is lazily-expired", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]);
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
    const tier2Rows = [
      {
        id: "bp-1",
        taskModelProviderId: "prov-1",
        memoryExtractionProviderId: null,
        memoryEmbeddingProviderId: null,
        context: "Default context",
      },
    ];

    it("creates the attachments and stamps Tier 2 settings", async () => {
      mockSession();
      mockDb.limit
        .mockResolvedValueOnce([{ role: "admin" }])
        .mockResolvedValueOnce([{ id: "bp-1" }])
        .mockResolvedValueOnce([{ id: "ws-1" }]);
      mockDb.where
        .mockReturnValueOnce(mockDb)
        .mockReturnValueOnce(mockDb)
        .mockReturnValueOnce(mockDb)
        .mockResolvedValueOnce(tier2Rows)
        .mockResolvedValueOnce(itemRows);
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
      const tier2Set = mockDb.set.mock.calls
        .map((c) => c[0] as Record<string, unknown>)
        .find((v) => v.taskModelProviderId !== undefined);
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
        .mockResolvedValueOnce(tier2Rows)
        .mockResolvedValueOnce(itemRows);
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
        ])
        .mockResolvedValueOnce([]);

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
        .mockResolvedValueOnce([{ role: "admin" }])
        .mockResolvedValueOnce([]);

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
        .mockResolvedValueOnce([{ role: "admin" }])
        .mockResolvedValueOnce([{ id: "bp-1" }])
        .mockResolvedValueOnce([]);

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
