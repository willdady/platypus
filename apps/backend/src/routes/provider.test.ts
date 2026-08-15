import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockDb, mockSession, resetMockDb } from "../test-utils.ts";
import app from "../server.ts";

describe("Provider Routes", () => {
  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
    mockDb.where.mockReturnValue(mockDb);
  });

  const orgId = "org-1";
  const workspaceId = "ws-1";
  const baseUrl = `/organizations/${orgId}/workspaces/${workspaceId}/providers`;

  describe("POST /", () => {
    it("should create provider if workspace admin", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]); // requireWorkspaceAccess

      const mockProvider = { id: "p1", name: "OpenAI", providerType: "OpenAI" };
      mockDb.returning.mockResolvedValueOnce([mockProvider]);

      const res = await app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify({
          name: "OpenAI",
          providerType: "OpenAI",
          apiKey: "sk-123",
          modelIds: ["gpt-4"],
          taskModelId: "gpt-4",
          memoryExtractionModelId: "gpt-4",
          workspaceId,
        }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(201);
      expect(await res.json()).toEqual(mockProvider);
    });

    it("takes the scope from the route, ignoring any scope in the body", async () => {
      // A workspace-surface create is always Workspace-scoped. Spreading the body
      // let a caller name another Workspace, or set organizationId and mint a
      // Shared Provider here — which only an Org Admin may do (ADR-0006/0007).
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]); // requireWorkspaceAccess

      mockDb.returning.mockResolvedValueOnce([{ id: "p1", name: "OpenAI" }]);

      const res = await app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify({
          name: "OpenAI",
          providerType: "OpenAI",
          apiKey: "sk-123",
          modelIds: ["gpt-4"],
          taskModelId: "gpt-4",
          memoryExtractionModelId: "gpt-4",
          workspaceId: "ws-somewhere-else",
          organizationId: orgId,
        }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(201);
      expect(mockDb.values).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId, organizationId: null }),
      );
    });

    it("should return 409 if provider name already exists in workspace", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]); // requireWorkspaceAccess

      const drizzleError = Object.assign(
        new Error("DrizzleQueryError: Failed query"),
        {
          cause: {
            code: "23505",
            message:
              'duplicate key value violates unique constraint "unique_provider_name_workspace"',
          },
        },
      );

      mockDb.returning.mockRejectedValueOnce(drizzleError);

      const res = await app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify({
          name: "Duplicate OpenAI",
          providerType: "OpenAI",
          apiKey: "sk-123",
          modelIds: ["gpt-4"],
          taskModelId: "gpt-4",
          memoryExtractionModelId: "gpt-4",
          workspaceId,
        }),
        headers: { "Content-Type": "application/json" },
      });

      // The unique violation flows through the central onError (ADR-0010).
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error: "A resource with that name already exists",
      });
    });

    // ADR-0006: workspace-provider config is admin-only unless the workspace's
    // providerSelfManagement flag delegates it to the owner.
    const createBody = {
      name: "OpenAI",
      providerType: "OpenAI",
      apiKey: "sk-123",
      modelIds: ["gpt-4"],
      taskModelId: "gpt-4",
      memoryExtractionModelId: "gpt-4",
      workspaceId,
    };

    it("returns 403 for a non-admin owner when self-management is disabled", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]); // requireWorkspaceAccess
      mockDb.limit.mockResolvedValueOnce([{ flag: false }]); // delegation flag

      const res = await app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify(createBody),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(403);
    });

    it("allows a non-admin owner when self-management is enabled", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]);
      mockDb.limit.mockResolvedValueOnce([{ flag: true }]); // delegation flag set
      mockDb.returning.mockResolvedValueOnce([{ id: "p1", name: "OpenAI" }]);

      const res = await app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify(createBody),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(201);
    });
  });

  describe("GET /", () => {
    it("should list workspace providers and only attached org providers", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]); // requireWorkspaceAccess

      const workspaceProviders = [
        { id: "p1", name: "WS OpenAI", apiKey: "sk-ws" },
      ];
      // Org-scoped query is an inner join on attachment → rows nest under `provider`.
      const orgProviders = [
        {
          provider: {
            id: "p2",
            name: "Org OpenAI",
            organizationId: orgId,
            apiKey: "sk-org",
          },
        },
      ];

      mockDb.where
        .mockReturnValueOnce(mockDb) // requireOrgAccess
        .mockReturnValueOnce(mockDb) // requireWorkspaceAccess
        .mockResolvedValueOnce(workspaceProviders)
        .mockResolvedValueOnce(orgProviders);
      // workspaceConfigAccess — providerSelfManagement not delegated
      mockDb.limit.mockResolvedValueOnce([{ flag: false }]);

      const res = await app.request(baseUrl);
      expect(res.status).toBe(200);
      const data = (await res.json()) as Record<string, unknown>;
      expect(data.results).toHaveLength(2);
      expect(data.results).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "p1", scope: "workspace" }),
          expect.objectContaining({ id: "p2", scope: "organization" }),
        ]),
      );
    });

    it("redacts apiKey when the owner has no providerSelfManagement", async () => {
      // ADR-0006: a Workspace Owner who was not delegated Provider management
      // may still LIST providers — selecting one on an Agent does not need the
      // delegation — but must not receive the stored credential.
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]); // requireWorkspaceAccess

      mockDb.where
        .mockReturnValueOnce(mockDb)
        .mockReturnValueOnce(mockDb)
        .mockResolvedValueOnce([
          {
            id: "p1",
            name: "WS OpenAI",
            apiKey: "sk-secret",
            headers: { Authorization: "Bearer nope" },
          },
        ])
        .mockResolvedValueOnce([]);
      mockDb.limit.mockResolvedValueOnce([{ flag: false }]);

      const res = await app.request(baseUrl);
      expect(res.status).toBe(200);
      const data = (await res.json()) as { results: Record<string, unknown>[] };
      const [row] = data.results;
      expect(row).not.toHaveProperty("apiKey");
      expect(row).not.toHaveProperty("headers");
      expect(row.apiKeySet).toEqual({ configured: true });
      expect(row.headersSet).toEqual({ configured: true });
      expect(JSON.stringify(data)).not.toContain("sk-secret");
    });

    it("reveals apiKey to an org admin", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]); // requireWorkspaceAccess

      mockDb.where
        .mockReturnValueOnce(mockDb)
        .mockReturnValueOnce(mockDb)
        .mockResolvedValueOnce([
          { id: "p1", name: "WS OpenAI", apiKey: "sk-secret" },
        ])
        .mockResolvedValueOnce([]);
      // No delegation lookup: an org admin short-circuits workspaceConfigAccess.

      const res = await app.request(baseUrl);
      expect(res.status).toBe(200);
      const data = (await res.json()) as { results: Record<string, unknown>[] };
      expect(data.results[0].apiKey).toBe("sk-secret");
    });

    it("reveals apiKey to an owner who was delegated providerSelfManagement", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]); // requireWorkspaceAccess

      mockDb.where
        .mockReturnValueOnce(mockDb)
        .mockReturnValueOnce(mockDb)
        .mockResolvedValueOnce([
          { id: "p1", name: "WS OpenAI", apiKey: "sk-secret" },
        ])
        .mockResolvedValueOnce([]);
      mockDb.limit.mockResolvedValueOnce([{ flag: true }]);

      const res = await app.request(baseUrl);
      expect(res.status).toBe(200);
      const data = (await res.json()) as { results: Record<string, unknown>[] };
      expect(data.results[0].apiKey).toBe("sk-secret");
    });
  });

  describe("GET /:providerId", () => {
    it("should return provider with scope", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]); // requireWorkspaceAccess

      const mockProvider = { id: "p1", name: "OpenAI", workspaceId };
      mockDb.limit.mockResolvedValueOnce([mockProvider]);
      // workspaceConfigAccess — providerSelfManagement not delegated
      mockDb.limit.mockResolvedValueOnce([{ flag: false }]);

      const res = await app.request(`${baseUrl}/p1`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        ...mockProvider,
        apiKeySet: { configured: false },
        headersSet: { configured: false },
        scope: "workspace",
      });
    });

    it("redacts apiKey when the owner has no providerSelfManagement", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]); // requireWorkspaceAccess
      mockDb.limit.mockResolvedValueOnce([
        { id: "p1", name: "OpenAI", workspaceId, apiKey: "sk-secret" },
      ]); // resolveScoped
      mockDb.limit.mockResolvedValueOnce([{ flag: false }]); // not delegated

      const res = await app.request(`${baseUrl}/p1`);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).not.toContain("sk-secret");
      expect(JSON.parse(body)).not.toHaveProperty("apiKey");
    });

    it("should 404 for an org-scoped provider not attached here", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]); // requireWorkspaceAccess
      // resolveScoped row lookup → org-scoped provider...
      mockDb.limit.mockResolvedValueOnce([
        { id: "p2", name: "Org OpenAI", organizationId: orgId },
      ]);
      // ...attachment check → not attached here → not visible → 404
      mockDb.limit.mockResolvedValueOnce([]);

      const res = await app.request(`${baseUrl}/p2`);
      expect(res.status).toBe(404);
    });
  });

  describe("PUT /:providerId", () => {
    const updateBody = {
      name: "Renamed",
      providerType: "OpenAI",
      apiKey: "sk-123",
      modelIds: ["gpt-4"],
      taskModelId: "gpt-4",
      memoryExtractionModelId: "gpt-4",
    };

    it("updates a workspace-scoped provider and returns the row", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]); // requireWorkspaceAccess
      // requireWorkspaceMutable → resolveScoped → workspace-scoped row (no
      // attachment check needed)
      mockDb.limit.mockResolvedValueOnce([{ id: "p1", workspaceId }]);
      // currentProviderModels → the pre-save models, for the alias diff
      mockDb.limit.mockResolvedValueOnce([{ modelIds: [{ id: "gpt-4" }] }]);

      const updated = { id: "p1", name: "Renamed", workspaceId };
      mockDb.returning.mockResolvedValueOnce([updated]);

      const res = await app.request(`${baseUrl}/p1`, {
        method: "PUT",
        body: JSON.stringify(updateBody),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(200);
      // The single row, not the raw `.returning()` array, plus the
      // alias de-migration report (empty — no alias was removed).
      expect(await res.json()).toEqual({ ...updated, aliasRepoints: [] });
    });

    it("reports how many Agents and Chats were repointed when an alias is removed", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]); // requireWorkspaceAccess
      mockDb.limit.mockResolvedValueOnce([{ id: "p1", workspaceId }]);
      // The alias `flagship` exists before this save and not after it.
      mockDb.limit.mockResolvedValueOnce([
        { modelIds: [{ id: "gpt-4", alias: "flagship" }] },
      ]);

      const updated = { id: "p1", name: "Renamed", workspaceId };
      mockDb.returning
        .mockResolvedValueOnce([updated]) // the provider row
        .mockResolvedValueOnce([{ id: "a1" }, { id: "a2" }]) // Agents repointed
        .mockResolvedValueOnce([{ id: "c1" }]); // Chats repointed

      const res = await app.request(`${baseUrl}/p1`, {
        method: "PUT",
        body: JSON.stringify(updateBody),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        ...updated,
        aliasRepoints: [
          { alias: "flagship", modelId: "gpt-4", agents: 2, chats: 1 },
        ],
      });
    });

    it("should 403 when updating an attached org-scoped provider", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]); // requireWorkspaceAccess
      // requireWorkspaceMutable → resolveScoped row lookup → org-scoped provider...
      mockDb.limit.mockResolvedValueOnce([
        { id: "p2", name: "Org OpenAI", organizationId: orgId },
      ]);
      // ...attachment check → attached, so it is visible but locked
      mockDb.limit.mockResolvedValueOnce([{ id: "att-1" }]);

      const res = await app.request(`${baseUrl}/p2`, {
        method: "PUT",
        body: JSON.stringify(updateBody),
        headers: { "Content-Type": "application/json" },
      });
      // Shared providers are edited only on the Organization surface (ADR-0007).
      expect(res.status).toBe(403);
      expect(mockDb.update).not.toHaveBeenCalled();
    });
  });

  describe("DELETE /:providerId", () => {
    it("deletes a workspace-scoped provider", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]); // requireWorkspaceAccess
      // requireWorkspaceMutable → resolveScoped → workspace-scoped row (no
      // attachment check needed)
      mockDb.limit.mockResolvedValueOnce([{ id: "p1", workspaceId }]);

      const res = await app.request(`${baseUrl}/p1`, { method: "DELETE" });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ message: "Provider deleted" });
    });

    it("should 404 when deleting an org-scoped provider not attached here", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]); // requireWorkspaceAccess
      // resolveScoped row lookup → org-scoped provider...
      mockDb.limit.mockResolvedValueOnce([
        { id: "p2", name: "Org OpenAI", organizationId: orgId },
      ]);
      // ...attachment check → not attached here → 404
      mockDb.limit.mockResolvedValueOnce([]);

      const res = await app.request(`${baseUrl}/p2`, { method: "DELETE" });
      expect(res.status).toBe(404);
      expect(mockDb.delete).not.toHaveBeenCalled();
    });

    it("should 403 when deleting an attached org-scoped provider", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]); // requireWorkspaceAccess
      // resolveScoped row lookup → org-scoped provider...
      mockDb.limit.mockResolvedValueOnce([
        { id: "p2", name: "Org OpenAI", organizationId: orgId },
      ]);
      // ...attachment check → attached, so it is visible but locked
      mockDb.limit.mockResolvedValueOnce([{ id: "att-1" }]);

      const res = await app.request(`${baseUrl}/p2`, { method: "DELETE" });
      expect(res.status).toBe(403);
      expect(mockDb.delete).not.toHaveBeenCalled();
    });
  });
});
