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
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]); // requireWorkspaceAccess

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
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]); // requireWorkspaceAccess

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

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        message: "A provider with this name already exists in this workspace",
      });
    });
  });

  describe("GET /", () => {
    it("should list providers (workspace + org)", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]); // requireWorkspaceAccess

      const workspaceProviders = [{ id: "p1", name: "WS OpenAI" }];
      const orgProviders = [
        { id: "p2", name: "Org OpenAI", organizationId: orgId },
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
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]); // requireWorkspaceAccess

      const mockProvider = { id: "p1", name: "OpenAI", workspaceId };
      mockDb.limit.mockResolvedValueOnce([mockProvider]);

      const res = await app.request(`${baseUrl}/p1`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ...mockProvider, scope: "workspace" });
    });
  });
});
