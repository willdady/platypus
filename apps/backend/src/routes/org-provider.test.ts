import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockDb, mockSession, resetMockDb } from "../test-utils.ts";
import app from "../server.ts";

describe("Organization Provider Routes", () => {
  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
    mockDb.where.mockReturnValue(mockDb);
  });

  const orgId = "org-1";
  const baseUrl = `/organizations/${orgId}/providers`;

  describe("POST /", () => {
    it("should create org provider if org admin", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]); // requireOrgAccess

      const mockProvider = {
        id: "p1",
        name: "Org OpenAI",
        providerType: "OpenAI",
        organizationId: orgId,
      };
      mockDb.returning.mockResolvedValueOnce([mockProvider]);

      const res = await app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify({
          name: "Org OpenAI",
          providerType: "OpenAI",
          apiKey: "sk-123",
          modelIds: ["gpt-4"],
          taskModelId: "gpt-4",
          organizationId: orgId,
        }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(201);
      expect(await res.json()).toEqual(mockProvider);
    });

    it("should fail if not org admin", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess

      const res = await app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify({
          name: "Org OpenAI",
          providerType: "OpenAI",
          apiKey: "sk-123",
          modelIds: ["gpt-4"],
          taskModelId: "gpt-4",
          organizationId: orgId,
        }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(403);
    });

    it("should return 409 if provider name already exists in org", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "admin" }]); // requireOrgAccess

      const drizzleError = new Error("DrizzleQueryError: Failed query");
      (drizzleError as any).cause = {
        code: "23505",
        message:
          'duplicate key value violates unique constraint "unique_provider_name_org"',
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
          organizationId: orgId,
        }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        message:
          "A provider with this name already exists in this organization",
      });
    });
  });

  describe("GET /", () => {
    it("should list org providers", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess

      const mockProviders = [{ id: "p1", name: "Org OpenAI" }];
      mockDb.where
        .mockReturnValueOnce(mockDb) // requireOrgAccess
        .mockResolvedValueOnce(mockProviders);

      const res = await app.request(baseUrl);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ results: mockProviders });
    });
  });

  describe("GET /:providerId", () => {
    it("should return org provider", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess

      const mockProvider = { id: "p1", name: "Org OpenAI" };
      mockDb.where
        .mockReturnValueOnce(mockDb) // requireOrgAccess
        .mockReturnValueOnce(mockDb); // route
      mockDb.limit.mockResolvedValueOnce([mockProvider]); // route

      const res = await app.request(`${baseUrl}/p1`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(mockProvider);
    });
  });
});
