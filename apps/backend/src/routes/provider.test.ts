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

    it("should return 409 if provider name already exists in workspace", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]); // requireWorkspaceAccess

      const drizzleError = new Error("DrizzleQueryError: Failed query");
      (drizzleError as any).cause = {
        code: "23505",
        message:
          'duplicate key value violates unique constraint "unique_provider_name_workspace"',
      };

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

      const workspaceProviders = [{ id: "p1", name: "WS OpenAI" }];
      // Org-scoped query is an inner join on attachment → rows nest under `provider`.
      const orgProviders = [
        { provider: { id: "p2", name: "Org OpenAI", organizationId: orgId } },
      ];

      mockDb.where
        .mockReturnValueOnce(mockDb) // requireOrgAccess
        .mockReturnValueOnce(mockDb) // requireWorkspaceAccess
        .mockResolvedValueOnce(workspaceProviders)
        .mockResolvedValueOnce(orgProviders);

      const res = await app.request(baseUrl);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.results).toHaveLength(2);
      expect(data.results).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "p1", scope: "workspace" }),
          expect.objectContaining({ id: "p2", scope: "organization" }),
        ]),
      );
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

      const res = await app.request(`${baseUrl}/p1`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ...mockProvider, scope: "workspace" });
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

      const updated = { id: "p1", name: "Renamed", workspaceId };
      mockDb.returning.mockResolvedValueOnce([updated]);

      const res = await app.request(`${baseUrl}/p1`, {
        method: "PUT",
        body: JSON.stringify(updateBody),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(200);
      // The single row, not the raw `.returning()` array.
      expect(await res.json()).toEqual(updated);
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
