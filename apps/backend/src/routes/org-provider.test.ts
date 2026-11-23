import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  insertTimestamps,
  mockSession,
  resetMockDb,
  seedDb,
  type FakeDb,
  type Row,
  type Store,
} from "../test-utils.ts";
import app from "../server.ts";

// why: file-local, as the `ai` mock must be in place before `ai` is first imported
const { mockGenerateText, mockCreateOpenAI } = vi.hoisted(() => ({
  mockGenerateText: vi.fn(),
  mockCreateOpenAI: vi.fn(
    (_config: Record<string, unknown>) => (modelId: string) => ({ modelId }),
  ),
}));

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return { ...actual, generateText: mockGenerateText };
});
vi.mock("@ai-sdk/openai", () => ({ createOpenAI: mockCreateOpenAI }));

describe("Organization Provider Routes", () => {
  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
    mockGenerateText.mockReset();
  });

  const orgId = "org-1";
  const baseUrl = `/organizations/${orgId}/providers`;

  const json = (method: string, body: unknown) => ({
    method,
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });

  const sharedProvider = (over: Row = {}): Row => ({
    id: "p1",
    name: "Org OpenAI",
    providerType: "OpenAI",
    apiKey: "sk-secret",
    organizationId: orgId,
    workspaceId: null,
    apiMode: "responses",
    searchSource: "native",
    modelIds: [{ id: "gpt-4" }],
    taskModelId: "gpt-4",
    memoryExtractionModelId: "gpt-4",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...over,
  });

  const world = (
    role: "admin" | "member" = "admin",
    rows: Store = {},
  ): FakeDb =>
    seedDb(
      {
        organization_member: [
          { id: "m1", userId: "user-1", organizationId: orgId, role },
        ],
        workspace: [{ id: "ws-1", organizationId: orgId, ownerId: "user-1" }],
        provider: [
          sharedProvider(),
          sharedProvider({ id: "p-other-org", organizationId: "org-2" }),
          sharedProvider({
            id: "p-ws",
            organizationId: null,
            workspaceId: "ws-1",
          }),
        ],
        ...rows,
      },
      {
        unique: {
          provider: [
            {
              name: "unique_provider_name_org",
              columns: ["organizationId", "name"],
              where: (row) => row.organizationId != null,
            },
          ],
        },
        defaults: { provider: insertTimestamps() },
      },
    );

  const idsOf = (fake: FakeDb) => fake.tables.provider.map((p) => p.id);

  describe("POST /", () => {
    const createBody = {
      name: "New OpenAI",
      providerType: "OpenAI",
      apiKey: "sk-123",
      apiMode: "responses" as const,
      searchSource: "native",
      modelIds: [{ id: "gpt-4", passthroughFileTypes: [] }],
      taskModelId: "gpt-4",
      memoryExtractionModelId: "gpt-4",
    };

    it("should create org provider if org admin", async () => {
      mockSession();
      const fake = world("admin");

      const res = await app.request(baseUrl, json("POST", createBody));

      expect(res.status).toBe(201);
      expect(await res.json()).toMatchObject({
        name: "New OpenAI",
        providerType: "OpenAI",
        organizationId: orgId,
        workspaceId: null,
        scope: "organization",
        apiKey: "sk-123",
        apiKeySet: { configured: true },
      });
      expect(fake.tables.provider).toHaveLength(4);
    });

    it("should fail if not org admin", async () => {
      mockSession();
      const fake = world("member");

      const res = await app.request(baseUrl, json("POST", createBody));

      expect(res.status).toBe(403);
      expect(fake.tables.provider).toHaveLength(3);
    });

    it("should return 409 if provider name already exists in org", async () => {
      mockSession();
      const fake = world("admin");

      const res = await app.request(
        baseUrl,
        json("POST", { ...createBody, name: "Org OpenAI" }),
      );

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error: "A resource with that name already exists",
      });
      expect(fake.tables.provider).toHaveLength(3);
    });
  });

  describe("GET /", () => {
    const list = async () => {
      const res = await app.request(baseUrl);
      const body = (await res.json()) as { results: Row[] };
      return { status: res.status, results: body.results };
    };

    it("should list only this organization's Shared providers", async () => {
      mockSession();
      world("member");

      const { status, results } = await list();

      expect(status).toBe(200);
      expect(results.map((r) => r.id)).toEqual(["p1"]);
      expect(results).toEqual([
        expect.objectContaining({ scope: "organization" }),
      ]);
    });

    it("redacts apiKey for a non-admin member", async () => {
      mockSession();
      world("member");

      const [row] = (await list()).results;

      expect(row).not.toHaveProperty("apiKey");
      expect(row).toMatchObject({
        apiKeySet: { configured: true },
        headersSet: { configured: false },
      });
    });

    it("reveals apiKey to an org admin", async () => {
      mockSession();
      world("admin");

      const [row] = (await list()).results;

      expect(row.apiKey).toBe("sk-secret");
    });
  });

  describe("GET /:providerId", () => {
    it("should return org provider, redacted for a member", async () => {
      mockSession();
      world("member");

      const res = await app.request(`${baseUrl}/p1`);

      expect(res.status).toBe(200);
      const body = (await res.json()) as Row;
      expect(body).toMatchObject({
        id: "p1",
        name: "Org OpenAI",
        apiKeySet: { configured: true },
      });
      expect(body).not.toHaveProperty("apiKey");
    });

    it.each([
      ["another organization's Shared provider", "p-other-org"],
      ["a Workspace-scoped provider", "p-ws"],
    ])("returns 404 for %s", async (_label, id) => {
      mockSession();
      world("admin");

      const res = await app.request(`${baseUrl}/${id}`);
      expect(res.status).toBe(404);
    });
  });

  describe("PUT /:providerId", () => {
    const updateBody = {
      name: "Renamed",
      providerType: "OpenAI",
      apiKey: "sk-123",
      apiMode: "responses" as const,
      searchSource: "native",
      modelIds: [{ id: "gpt-4", passthroughFileTypes: [] }],
      taskModelId: "gpt-4",
      memoryExtractionModelId: "gpt-4",
    };

    it("updates an org provider and returns the row", async () => {
      mockSession();
      const fake = world("admin");

      const res = await app.request(`${baseUrl}/p1`, json("PUT", updateBody));

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        id: "p1",
        name: "Renamed",
        organizationId: orgId,
        aliasRepoints: [],
        scope: "organization",
        apiKey: "sk-123",
        apiKeySet: { configured: true },
      });
      expect(fake.tables.provider.find((p) => p.id === "p1")).toMatchObject({
        name: "Renamed",
      });
    });

    it.each([
      ["missing", "missing"],
      ["another organization's Shared provider", "p-other-org"],
      ["a Workspace-scoped provider", "p-ws"],
    ])("returns 404 for %s, without touching the write", async (_label, id) => {
      mockSession();
      const fake = world("admin");

      const res = await app.request(
        `${baseUrl}/${id}`,
        json("PUT", updateBody),
      );

      expect(res.status).toBe(404);
      expect(fake.tables.provider.map((p) => p.name)).not.toContain("Renamed");
      expect(fake.queries.some((q) => q.kind === "update")).toBe(false);
    });

    it("returns 403 for a non-admin", async () => {
      mockSession();
      const fake = world("member");

      const res = await app.request(`${baseUrl}/p1`, json("PUT", updateBody));

      expect(res.status).toBe(403);
      expect(fake.queries.some((q) => q.kind === "update")).toBe(false);
    });
  });

  describe("DELETE /:providerId", () => {
    const remove = (id = "p1") =>
      app.request(`${baseUrl}/${id}`, { method: "DELETE" });

    it("deletes an org provider if admin and not attached", async () => {
      mockSession();
      const fake = world("admin");

      const res = await remove();

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ message: "Provider deleted" });
      expect(idsOf(fake)).toEqual(["p-other-org", "p-ws"]);
    });

    it("invalidates memory embeddings before deleting, without de-migrating aliases", async () => {
      mockSession();
      const fake = world("admin");

      const res = await remove();

      expect(res.status).toBe(200);
      expect(fake.execute).toHaveBeenCalledTimes(1);
      expect(idsOf(fake)).not.toContain("p1");
    });

    it.each([
      ["another organization's Shared provider", "p-other-org"],
      ["a Workspace-scoped provider", "p-ws"],
    ])("returns 404 for %s, leaving it in place", async (_label, id) => {
      mockSession();
      const fake = world("admin");

      const res = await remove(id);

      expect(res.status).toBe(404);
      expect(idsOf(fake)).toEqual(["p1", "p-other-org", "p-ws"]);
    });

    it("returns 409 when the provider is attached to a workspace", async () => {
      mockSession();
      const fake = world("admin", {
        attachment: [
          {
            id: "att-1",
            workspaceId: "ws-1",
            resourceType: "provider",
            resourceId: "p1",
          },
        ],
      });

      const res = await remove();

      expect(res.status).toBe(409);
      expect(idsOf(fake)).toContain("p1");
    });

    it("returns 409 when the provider is listed in a blueprint", async () => {
      mockSession();
      const fake = world("admin", {
        blueprint_item: [
          {
            id: "bpi-1",
            blueprintId: "bp-1",
            resourceType: "provider",
            resourceId: "p1",
          },
        ],
      });

      const res = await remove();

      expect(res.status).toBe(409);
      expect(idsOf(fake)).toContain("p1");
    });

    it("returns 403 for a non-admin", async () => {
      mockSession();
      const fake = world("member");

      const res = await remove();

      expect(res.status).toBe(403);
      expect(idsOf(fake)).toContain("p1");
    });
  });

  describe("POST /test", () => {
    const testBody = {
      name: "Org OpenAI",
      providerType: "OpenAI",
      apiKey: "sk-unsaved",
      apiMode: "responses",
      modelIds: [{ id: "gpt-4", passthroughFileTypes: [] }],
      modelId: "gpt-4",
    };

    const probe = () => app.request(`${baseUrl}/test`, json("POST", testBody));

    it("tests the unsaved config without needing a stored Provider", async () => {
      mockSession();
      world("admin");
      mockGenerateText.mockResolvedValue({ text: "ok" });

      const res = await probe();

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        success: true,
        modelId: "gpt-4",
        sessionIdSubstituted: false,
      });
      expect(mockCreateOpenAI.mock.calls.at(-1)?.[0]).toEqual(
        expect.objectContaining({ apiKey: "sk-unsaved" }),
      );
    });

    it("returns 403 for a non-admin", async () => {
      mockSession();
      world("member");

      const res = await probe();

      expect(res.status).toBe(403);
      expect(mockGenerateText).not.toHaveBeenCalled();
    });

    it("returns 403 for a caller outside the Organization", async () => {
      mockSession();
      world("admin", {
        organization_member: [
          {
            id: "m1",
            userId: "user-1",
            organizationId: "org-2",
            role: "admin",
          },
        ],
      });

      const res = await probe();

      expect(res.status).toBe(403);
      expect(mockGenerateText).not.toHaveBeenCalled();
    });
  });
});
