import { describe, it, expect, beforeEach, vi } from "vitest";
import { APICallError } from "ai";
import {
  insertTimestamps,
  mockSession,
  resetMockDb,
  seedDb,
  type FakeDb,
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

describe("Provider Routes", () => {
  let fake: FakeDb;

  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
    // why: clearAllMocks keeps implementations, so one case's rejection would leak into the next
    mockGenerateText.mockReset();
  });

  const orgId = "org-1";
  const workspaceId = "ws-1";
  const baseUrl = `/organizations/${orgId}/workspaces/${workspaceId}/providers`;

  const world = (
    options: {
      role?: "admin" | "member";
      providerSelfManagement?: boolean;
      rows?: Store;
    } = {},
  ): FakeDb => {
    const {
      role = "admin",
      providerSelfManagement = false,
      rows = {},
    } = options;
    return seedDb(
      {
        organization_member: [
          { id: "m1", userId: "user-1", organizationId: orgId, role },
        ],
        workspace: [
          {
            id: workspaceId,
            name: "Alpha",
            organizationId: orgId,
            ownerId: "user-1",
            providerSelfManagement,
          },
          {
            id: "ws-2",
            name: "Beta",
            organizationId: orgId,
            ownerId: "user-1",
            providerSelfManagement,
          },
        ],
        ...rows,
      },
      {
        unique: {
          provider: [
            {
              name: "unique_provider_name_workspace",
              columns: ["workspaceId", "name"],
            },
          ],
        },
        defaults: { provider: insertTimestamps() },
      },
    );
  };

  const workspaceProvider = (over: Store[string][number] = {}) => ({
    id: "p1",
    name: "WS OpenAI",
    providerType: "OpenAI",
    apiKey: "sk-secret",
    organizationId: null,
    workspaceId,
    apiMode: "responses",
    searchSource: "native",
    modelIds: [{ id: "gpt-4" }],
    taskModelId: "gpt-4",
    memoryExtractionModelId: "gpt-4",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...over,
  });

  const sharedProvider = (over: Store[string][number] = {}) => ({
    id: "p2",
    name: "Org OpenAI",
    providerType: "OpenAI",
    apiKey: "sk-org",
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

  const attachedHere = (resourceId: string) => ({
    id: "att-1",
    workspaceId,
    resourceType: "provider",
    resourceId,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  });

  describe("POST /", () => {
    const createBody = {
      name: "OpenAI",
      providerType: "OpenAI",
      apiKey: "sk-123",
      apiMode: "responses" as const,
      searchSource: "native",
      modelIds: [{ id: "gpt-4", passthroughFileTypes: [] }],
      taskModelId: "gpt-4",
      memoryExtractionModelId: "gpt-4",
    };

    const post = (payload: unknown = createBody) =>
      app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify(payload),
        headers: { "Content-Type": "application/json" },
      });

    it("should create provider if workspace admin", async () => {
      mockSession();
      fake = world({ rows: { provider: [] } });

      const res = await post();

      expect(res.status).toBe(201);
      expect(await res.json()).toEqual(
        expect.objectContaining({
          name: "OpenAI",
          providerType: "OpenAI",
          apiKey: "sk-123",
          apiKeySet: { configured: true },
          headersSet: { configured: false },
          scope: "workspace",
        }),
      );
      expect(fake.tables.provider).toHaveLength(1);
    });

    it("stores and returns both Job settings blocks (ADR-0045)", async () => {
      mockSession();
      fake = world({ rows: { provider: [] } });
      const taskModelSettings = { reasoningThinking: false, temperature: 0.2 };
      const memoryExtractionModelSettings = { reasoningEffort: "low", seed: 7 };

      const res = await post({
        ...createBody,
        taskModelSettings,
        memoryExtractionModelSettings,
      });

      expect(res.status).toBe(201);
      expect(await res.json()).toMatchObject({
        taskModelSettings,
        memoryExtractionModelSettings,
      });
      expect(fake.tables.provider[0]).toMatchObject({
        taskModelSettings,
        memoryExtractionModelSettings,
      });
    });

    it.each([
      ["a Temperature below zero", { temperature: -1 }],
      ["a Top-p above one", { topP: 2 }],
      ["an Effort step off the scale", { reasoningEffort: "extreme" }],
      ["a zero Thinking budget", { thinkingBudget: 0 }],
    ])("rejects Job settings with %s", async (_, taskModelSettings) => {
      mockSession();
      fake = world({ rows: { provider: [] } });

      const res = await post({ ...createBody, taskModelSettings });

      expect(res.status).toBe(400);
      expect(fake.tables.provider).toHaveLength(0);
    });

    it("rejects any scope in the body", async () => {
      mockSession();
      fake = world({ rows: { provider: [] } });

      const res = await post({
        ...createBody,
        workspaceId: "ws-2",
        organizationId: orgId,
      });

      expect(res.status).toBe(400);
      expect(fake.tables.provider).toHaveLength(0);
    });

    it("should return 409 if provider name already exists in workspace", async () => {
      mockSession();
      fake = world({
        rows: { provider: [workspaceProvider({ name: "Duplicate OpenAI" })] },
      });

      const res = await post({ ...createBody, name: "Duplicate OpenAI" });

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error: "A resource with that name already exists",
      });
      expect(fake.tables.provider).toHaveLength(1);
    });

    it("returns 403 for a non-admin owner when self-management is disabled", async () => {
      mockSession();
      fake = world({
        role: "member",
        providerSelfManagement: false,
        rows: { provider: [] },
      });

      const res = await post();
      expect(res.status).toBe(403);
      expect(fake.tables.provider).toHaveLength(0);
    });

    it("allows a non-admin owner when self-management is enabled", async () => {
      mockSession();
      fake = world({
        role: "member",
        providerSelfManagement: true,
        rows: { provider: [] },
      });

      const res = await post();
      expect(res.status).toBe(201);
      expect(fake.tables.provider).toHaveLength(1);
    });
  });

  describe("GET /", () => {
    const list = async () => {
      const res = await app.request(baseUrl);
      const data = (await res.json()) as {
        results: Record<string, unknown>[];
      };
      return { status: res.status, results: data.results };
    };

    it("lists this workspace's providers and only the org providers attached here", async () => {
      mockSession();
      world({
        role: "member",
        rows: {
          provider: [
            workspaceProvider(),
            sharedProvider(),
            sharedProvider({ id: "p3", name: "Unattached" }),
            workspaceProvider({
              id: "p4",
              name: "Beta OpenAI",
              workspaceId: "ws-2",
            }),
          ],
          attachment: [attachedHere("p2")],
        },
      });

      const { status, results } = await list();
      expect(status).toBe(200);
      expect(results).toEqual([
        expect.objectContaining({ id: "p1", scope: "workspace" }),
        expect.objectContaining({ id: "p2", scope: "organization" }),
      ]);
    });

    it("redacts apiKey when the owner has no providerSelfManagement", async () => {
      mockSession();
      world({
        role: "member",
        providerSelfManagement: false,
        rows: {
          provider: [
            workspaceProvider({ headers: { Authorization: "Bearer nope" } }),
          ],
        },
      });

      const { status, results } = await list();
      expect(status).toBe(200);
      const [row] = results;
      expect(row).not.toHaveProperty("apiKey");
      expect(row).not.toHaveProperty("headers");
      expect(row.apiKeySet).toEqual({ configured: true });
      expect(row.headersSet).toEqual({ configured: true });
      expect(JSON.stringify(results)).not.toContain("sk-secret");
    });

    it("reveals apiKey to an org admin", async () => {
      mockSession();
      world({ role: "admin", rows: { provider: [workspaceProvider()] } });

      const { status, results } = await list();
      expect(status).toBe(200);
      expect(results[0].apiKey).toBe("sk-secret");
    });

    it("reveals apiKey to an owner who was delegated providerSelfManagement", async () => {
      mockSession();
      world({
        role: "member",
        providerSelfManagement: true,
        rows: { provider: [workspaceProvider()] },
      });

      const { status, results } = await list();
      expect(status).toBe(200);
      expect(results[0].apiKey).toBe("sk-secret");
    });

    it("redacts a Shared Provider's apiKey from an owner delegated providerSelfManagement", async () => {
      mockSession();
      world({
        role: "member",
        providerSelfManagement: true,
        rows: {
          provider: [
            sharedProvider({ headers: { Authorization: "Bearer org-hdr" } }),
          ],
          attachment: [attachedHere("p2")],
        },
      });

      const { status, results } = await list();
      expect(status).toBe(200);
      expect(results[0]).not.toHaveProperty("apiKey");
      expect(results[0]).not.toHaveProperty("headers");
      expect(JSON.stringify(results)).not.toContain("sk-org");
      expect(JSON.stringify(results)).not.toContain("org-hdr");
    });
  });

  describe("GET /:providerId", () => {
    it("should return provider with scope", async () => {
      mockSession();
      world({
        role: "member",
        rows: {
          provider: [workspaceProvider({ apiKey: "", headers: null })],
        },
      });

      const res = await app.request(`${baseUrl}/p1`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(
        expect.objectContaining({
          id: "p1",
          apiKeySet: { configured: false },
          headersSet: { configured: false },
          scope: "workspace",
        }),
      );
    });

    it("redacts apiKey when the owner has no providerSelfManagement", async () => {
      mockSession();
      world({
        role: "member",
        providerSelfManagement: false,
        rows: { provider: [workspaceProvider()] },
      });

      const res = await app.request(`${baseUrl}/p1`);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).not.toContain("sk-secret");
      expect(JSON.parse(body)).not.toHaveProperty("apiKey");
    });

    it("redacts a Shared Provider's apiKey from an owner delegated providerSelfManagement", async () => {
      mockSession();
      world({
        role: "member",
        providerSelfManagement: true,
        rows: {
          provider: [sharedProvider()],
          attachment: [attachedHere("p2")],
        },
      });

      const res = await app.request(`${baseUrl}/p2`);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).not.toContain("sk-org");
      expect(JSON.parse(body)).not.toHaveProperty("apiKey");
    });

    it("should 404 for an org-scoped provider not attached here", async () => {
      mockSession();
      world({
        role: "member",
        rows: { provider: [sharedProvider()], attachment: [] },
      });

      const res = await app.request(`${baseUrl}/p2`);
      expect(res.status).toBe(404);
    });

    it("should 404 for another workspace's provider", async () => {
      mockSession();
      world({
        role: "member",
        rows: {
          provider: [
            workspaceProvider({
              id: "p4",
              name: "Beta OpenAI",
              workspaceId: "ws-2",
            }),
          ],
        },
      });

      const res = await app.request(`${baseUrl}/p4`);
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

    const put = (providerId: string, payload: unknown = updateBody) =>
      app.request(`${baseUrl}/${providerId}`, {
        method: "PUT",
        body: JSON.stringify(payload),
        headers: { "Content-Type": "application/json" },
      });

    it("updates a workspace-scoped provider and returns the row", async () => {
      mockSession();
      fake = world({ rows: { provider: [workspaceProvider()] } });

      const res = await put("p1");

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(
        expect.objectContaining({
          id: "p1",
          name: "Renamed",
          aliasRepoints: [],
          scope: "workspace",
          apiKey: "sk-123",
          apiKeySet: { configured: true },
        }),
      );
      expect(fake.tables.provider[0]).toMatchObject({ name: "Renamed" });
    });

    it("replaces and clears Job settings", async () => {
      mockSession();
      fake = world({
        rows: {
          provider: [
            workspaceProvider({
              taskModelSettings: { temperature: 0.2 },
              memoryExtractionModelSettings: { seed: 1 },
            }),
          ],
        },
      });

      const res = await put("p1", {
        ...updateBody,
        taskModelSettings: { topK: 40 },
        memoryExtractionModelSettings: null,
      });

      expect(res.status).toBe(200);
      expect(fake.tables.provider[0]).toMatchObject({
        taskModelSettings: { topK: 40 },
        memoryExtractionModelSettings: null,
      });
    });

    it("reports how many Agents and Chats were repointed when an alias is removed", async () => {
      mockSession();
      fake = world({
        rows: {
          provider: [
            workspaceProvider({
              modelIds: [{ id: "gpt-4", alias: "flagship" }],
            }),
          ],
          agent: [
            { id: "a1", providerId: "p1", modelId: "alias:flagship" },
            { id: "a2", providerId: "p1", modelId: "alias:FLAGSHIP" },
            { id: "a3", providerId: "p9", modelId: "alias:flagship" },
            { id: "a4", providerId: "p1", modelId: "gpt-4" },
          ],
          chat: [{ id: "c1", providerId: "p1", modelId: "alias:flagship" }],
        },
      });

      const res = await put("p1");

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(
        expect.objectContaining({
          aliasRepoints: [
            { alias: "flagship", modelId: "gpt-4", agents: 2, chats: 1 },
          ],
        }),
      );
      expect(fake.tables.agent.map((row) => row.modelId)).toEqual([
        "gpt-4",
        "gpt-4",
        "alias:flagship",
        "gpt-4",
      ]);
    });

    it("should 403 when updating an attached org-scoped provider", async () => {
      mockSession();
      fake = world({
        rows: {
          provider: [sharedProvider()],
          attachment: [attachedHere("p2")],
        },
      });

      const res = await put("p2");
      expect(res.status).toBe(403);
      expect(fake.tables.provider[0]).toMatchObject({ name: "Org OpenAI" });
    });

    it("should 404 when updating another workspace's provider", async () => {
      mockSession();
      fake = world({
        rows: {
          provider: [workspaceProvider({ id: "p4", workspaceId: "ws-2" })],
        },
      });

      const res = await put("p4");
      expect(res.status).toBe(404);
      expect(fake.tables.provider[0]).toMatchObject({ name: "WS OpenAI" });
    });
  });

  describe("DELETE /:providerId", () => {
    it("deletes a workspace-scoped provider", async () => {
      mockSession();
      fake = world({ rows: { provider: [workspaceProvider()] } });

      const res = await app.request(`${baseUrl}/p1`, { method: "DELETE" });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ message: "Provider deleted" });
      expect(fake.tables.provider).toHaveLength(0);
      expect(fake.execute).toHaveBeenCalledTimes(1);
    });

    it("should 409 naming the agents that still use the provider", async () => {
      mockSession();
      fake = world({
        rows: {
          provider: [workspaceProvider()],
          agent: [
            { id: "a1", workspaceId, providerId: "p1", name: "Helper" },
            { id: "a2", workspaceId, providerId: "p1", name: "Writer" },
          ],
        },
      });

      const res = await app.request(`${baseUrl}/p1`, { method: "DELETE" });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error:
          'Cannot delete: this provider is used by 2 agents ("Helper", "Writer"). Delete them or switch them to another provider first.',
      });
      expect(fake.tables.provider).toHaveLength(1);
      expect(fake.execute).not.toHaveBeenCalled();
    });

    it("should 404 when deleting an org-scoped provider not attached here", async () => {
      mockSession();
      fake = world({
        rows: { provider: [sharedProvider()], attachment: [] },
      });

      const res = await app.request(`${baseUrl}/p2`, { method: "DELETE" });
      expect(res.status).toBe(404);
      expect(fake.tables.provider).toHaveLength(1);
      expect(fake.execute).not.toHaveBeenCalled();
    });

    it("should 403 when deleting an attached org-scoped provider", async () => {
      mockSession();
      fake = world({
        rows: {
          provider: [sharedProvider()],
          attachment: [attachedHere("p2")],
        },
      });

      const res = await app.request(`${baseUrl}/p2`, { method: "DELETE" });
      expect(res.status).toBe(403);
      expect(fake.tables.provider).toHaveLength(1);
      expect(fake.execute).not.toHaveBeenCalled();
    });

    it("should 404 when deleting another workspace's provider", async () => {
      mockSession();
      fake = world({
        rows: {
          provider: [workspaceProvider({ id: "p4", workspaceId: "ws-2" })],
        },
      });

      const res = await app.request(`${baseUrl}/p4`, { method: "DELETE" });
      expect(res.status).toBe(404);
      expect(fake.tables.provider).toHaveLength(1);
    });
  });

  describe("POST /test", () => {
    const testBody = (over: Record<string, unknown> = {}) => ({
      name: "OpenAI",
      providerType: "OpenAI",
      apiKey: "sk-test",
      apiMode: "responses",
      modelIds: [{ id: "gpt-4", passthroughFileTypes: [] }],
      modelId: "gpt-4",
      ...over,
    });

    const probe = (payload: unknown = testBody()) =>
      app.request(`${baseUrl}/test`, {
        method: "POST",
        body: JSON.stringify(payload),
        headers: { "Content-Type": "application/json" },
      });

    it("runs one completion and reports success for the tested model", async () => {
      mockSession();
      world();
      mockGenerateText.mockResolvedValue({ text: "ok" });

      const res = await probe();

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        success: true,
        modelId: "gpt-4",
        sessionIdSubstituted: false,
      });
    });

    it("replaces ${SESSION_ID} in a header value with the fixed test id", async () => {
      mockSession();
      world();
      mockGenerateText.mockResolvedValue({ text: "ok" });

      const res = await probe(
        testBody({ headers: { "x-session": "sess-${SESSION_ID}" } }),
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(
        expect.objectContaining({ success: true, sessionIdSubstituted: true }),
      );
      expect(mockCreateOpenAI.mock.calls.at(-1)?.[0]).toEqual(
        expect.objectContaining({
          headers: { "x-session": "sess-provider-connection-test" },
        }),
      );
    });

    it("reports a rejected API key with the vendor's message", async () => {
      mockSession();
      world();
      mockGenerateText.mockRejectedValue(
        new APICallError({
          message: "Incorrect API key provided: sk-test.",
          url: "https://api.openai.com/v1/responses",
          requestBodyValues: {},
          statusCode: 401,
        }),
      );

      const res = await probe();

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        success: false,
        modelId: "gpt-4",
        failureClass: "api-key-rejected",
        message: "Incorrect API key provided: sk-test.",
        sessionIdSubstituted: false,
      });
    });

    it.each([
      {
        label: "a 404",
        error: new APICallError({
          message: "The model `gpt-5` does not exist.",
          url: "https://api.openai.com/v1/responses",
          requestBodyValues: {},
          statusCode: 404,
        }),
        failureClass: "model-not-available",
      },
      {
        label: "a vendor's own model-not-found wording on a 400",
        error: new APICallError({
          message: "Model 'gpt-5' not found",
          url: "https://api.openai.com/v1/responses",
          requestBodyValues: {},
          statusCode: 400,
        }),
        failureClass: "model-not-available",
      },
      {
        label: "a 400 naming the Responses API",
        error: new APICallError({
          message: "Unknown route /v1/responses. Use /v1/chat/completions.",
          url: "http://vllm.local/v1/responses",
          requestBodyValues: {},
          statusCode: 400,
        }),
        failureClass: "api-mode-wrong",
      },
      {
        label: "a rate limit",
        error: new APICallError({
          message: "Rate limit reached for gpt-4.",
          url: "https://api.openai.com/v1/responses",
          requestBodyValues: {},
          statusCode: 429,
        }),
        failureClass: "rate-limited",
      },
      {
        label: "a server error",
        error: new APICallError({
          message: "Internal server error",
          url: "https://api.openai.com/v1/responses",
          requestBodyValues: {},
          statusCode: 500,
        }),
        failureClass: "unknown",
      },
    ])("reports $label as $failureClass", async ({ error, failureClass }) => {
      mockSession();
      world();
      mockGenerateText.mockRejectedValue(error);

      const res = await probe();

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(
        expect.objectContaining({ success: false, failureClass }),
      );
    });

    it("reports a failed connection as an unreachable Base URL", async () => {
      mockSession();
      world();
      const failure = new TypeError("fetch failed", {
        cause: Object.assign(new Error("getaddrinfo ENOTFOUND"), {
          code: "ENOTFOUND",
        }),
      });
      mockGenerateText.mockRejectedValue(failure);

      const res = await probe();

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        success: false,
        modelId: "gpt-4",
        failureClass: "base-url-unreachable",
        message: "fetch failed",
        sessionIdSubstituted: false,
      });
    });

    it("reports a server that accepts the connection and never answers", async () => {
      mockSession();
      world();
      vi.useFakeTimers();
      try {
        mockGenerateText.mockReturnValue(new Promise(() => {}));
        const pending = probe();
        await vi.advanceTimersByTimeAsync(20_000);
        const res = await pending;

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual(
          expect.objectContaining({
            success: false,
            failureClass: "base-url-unreachable",
          }),
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("refuses a model the Provider does not list, without calling it", async () => {
      mockSession();
      world();

      const res = await probe(testBody({ modelId: "gpt-5" }));

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe(
        'Model "gpt-5" is not one of this Provider\'s models.',
      );
      expect(mockGenerateText).not.toHaveBeenCalled();
    });

    it("tests a half-filled form whose save-only fields are absent", async () => {
      mockSession();
      world();
      mockGenerateText.mockResolvedValue({ text: "ok" });

      const res = await probe({
        providerType: "OpenAI",
        apiKey: "sk-test",
        apiMode: "responses",
        modelIds: [{ id: "gpt-4", passthroughFileTypes: [] }],
        modelId: "gpt-4",
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(
        expect.objectContaining({ success: true }),
      );
    });

    it("resolves an alias reference in the tested model", async () => {
      mockSession();
      world();
      mockGenerateText.mockResolvedValue({ text: "ok" });

      const res = await probe(
        testBody({
          modelIds: [{ id: "gpt-4", alias: "fast", passthroughFileTypes: [] }],
          modelId: "alias:fast",
        }),
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        success: true,
        modelId: "alias:fast",
        sessionIdSubstituted: false,
      });
      expect(mockGenerateText.mock.calls.at(-1)?.[0]).toEqual(
        expect.objectContaining({ model: { modelId: "gpt-4" } }),
      );
    });

    it("returns 403 for a member who does not own this Workspace", async () => {
      mockSession();
      world({
        role: "member",
        providerSelfManagement: true,
        rows: {
          workspace: [
            {
              id: workspaceId,
              name: "Alpha",
              organizationId: orgId,
              ownerId: "user-2",
              providerSelfManagement: true,
            },
          ],
        },
      });

      expect((await probe()).status).toBe(403);
      expect(mockGenerateText).not.toHaveBeenCalled();
    });

    it("returns 403 for a non-admin owner when self-management is disabled", async () => {
      mockSession();
      world({ role: "member", providerSelfManagement: false });

      expect((await probe()).status).toBe(403);
      expect(mockGenerateText).not.toHaveBeenCalled();
    });

    it("allows a non-admin owner when self-management is enabled", async () => {
      mockSession();
      world({ role: "member", providerSelfManagement: true });
      mockGenerateText.mockResolvedValue({ text: "ok" });

      expect((await probe()).status).toBe(200);
    });
  });
});
