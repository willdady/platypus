import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockDb, mockSession, resetMockDb } from "../test-utils.ts";
import app from "../server.ts";

// Mock AI SDK
vi.mock("ai", async () => {
  const actual = await vi.importActual("ai");
  return {
    ...actual,
    streamText: vi.fn().mockReturnValue({
      toUIMessageStreamResponse: vi
        .fn()
        .mockReturnValue(new Response("stream")),
    }),
    generateText: vi.fn().mockResolvedValue({
      output: { title: "Generated Title", tags: ["tag1", "tag2"] },
    }),
    Output: {
      object: vi.fn().mockReturnValue({}),
    },
    convertToModelMessages: vi.fn().mockReturnValue([]),
    createIdGenerator: vi.fn().mockReturnValue(() => "msg-1"),
    stepCountIs: vi.fn(),
  };
});

vi.mock("@ai-sdk/openai", () => ({
  createOpenAI: vi.fn().mockReturnValue(vi.fn()),
}));

vi.mock("@openrouter/ai-sdk-provider", () => ({
  createOpenRouter: vi.fn().mockReturnValue(vi.fn()),
}));

vi.mock("@ai-sdk/mcp", () => ({
  experimental_createMCPClient: vi.fn().mockResolvedValue({
    tools: vi.fn().mockResolvedValue({}),
    close: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock("../services/memory-retrieval.ts", () => ({
  retrieveUserLevelMemories: vi.fn().mockResolvedValue([]),
  retrieveWorkspaceLevelMemories: vi.fn().mockResolvedValue([]),
  formatMemoriesForSystemPrompt: vi.fn().mockReturnValue(""),
}));

describe("Chat Routes", () => {
  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
    mockDb.where.mockReturnValue(mockDb);
    mockDb.orderBy.mockReturnValue(mockDb);
    mockDb.limit.mockReturnValue(mockDb);
    mockDb.offset.mockReturnValue(mockDb);
  });

  const orgId = "org-1";
  const workspaceId = "ws-1";
  const baseUrl = `/organizations/${orgId}/workspaces/${workspaceId}/chat`;

  describe("GET /", () => {
    it("should list chats", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]); // requireWorkspaceAccess

      const mockChats = [{ id: "chat-1", title: "Chat 1" }];
      mockDb.offset.mockResolvedValueOnce(mockChats);

      const res = await app.request(baseUrl);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ results: mockChats });
    });

    it("should filter chats by single tag", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]); // requireWorkspaceAccess

      const mockChats = [
        { id: "chat-1", title: "Chat 1", tags: ["typescript"] },
        { id: "chat-2", title: "Chat 2", tags: ["typescript", "react"] },
      ];
      mockDb.offset.mockResolvedValueOnce(mockChats);

      const res = await app.request(`${baseUrl}?tags=typescript`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ results: mockChats });
    });

    it("should filter chats by multiple tags (OR logic)", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]); // requireWorkspaceAccess

      const mockChats = [
        { id: "chat-1", title: "Chat 1", tags: ["typescript"] },
        { id: "chat-2", title: "Chat 2", tags: ["react"] },
        { id: "chat-3", title: "Chat 3", tags: ["typescript", "react"] },
      ];
      mockDb.offset.mockResolvedValueOnce(mockChats);

      const res = await app.request(`${baseUrl}?tags=typescript,react`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ results: mockChats });
    });

    it("should return empty array when tag filter has no matches", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]); // requireWorkspaceAccess

      mockDb.offset.mockResolvedValueOnce([]);

      const res = await app.request(`${baseUrl}?tags=nonexistent-tag`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ results: [] });
    });

    it("should return all chats when tags param is not provided (backward compatible)", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]); // requireWorkspaceAccess

      const mockChats = [
        { id: "chat-1", title: "Chat 1", tags: ["typescript"] },
        { id: "chat-2", title: "Chat 2", tags: ["react"] },
        { id: "chat-3", title: "Chat 3", tags: [] },
      ];
      mockDb.offset.mockResolvedValueOnce(mockChats);

      const res = await app.request(baseUrl);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ results: mockChats });
    });
  });

  describe("GET /tags", () => {
    it("should list tags", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]); // requireWorkspaceAccess

      const mockTags = [{ tag: "tag1", count: 5 }];
      mockDb.execute.mockResolvedValueOnce({ rows: mockTags });

      const res = await app.request(`${baseUrl}/tags`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ results: mockTags });
    });
  });

  describe("GET /:chatId", () => {
    it("should return chat", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]); // requireWorkspaceAccess

      const mockChat = { id: "chat-1", title: "Chat 1" };
      mockDb.limit.mockResolvedValueOnce([mockChat]);

      const res = await app.request(`${baseUrl}/chat-1`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(mockChat);
    });
  });

  describe("POST /", () => {
    it("should start a chat stream", async () => {
      mockSession({
        id: "user-1",
        name: "Test User",
        email: "test@example.com",
      });
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]); // requireWorkspaceAccess

      // fetch workspace
      mockDb.limit.mockResolvedValueOnce([
        {
          id: workspaceId,
          context: null,
        },
      ]);

      // resolveChatContext: fetch provider
      mockDb.limit.mockResolvedValueOnce([
        {
          id: "p1",
          providerType: "OpenAI",
          modelIds: ["m1"],
          workspaceId,
        },
      ]);

      // Mock .where() calls in sequence - first 4 return mockDb for chaining, 5th returns the promise
      mockDb.where.mockReturnValueOnce(mockDb); // requireOrgAccess
      mockDb.where.mockReturnValueOnce(mockDb); // requireWorkspaceAccess
      mockDb.where.mockReturnValueOnce(mockDb); // fetch workspace
      mockDb.where.mockReturnValueOnce(mockDb); // resolveChatContext
      mockDb.where.mockReturnValueOnce(Promise.resolve([])); // fetch user contexts (final call)

      const res = await app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify({
          id: "chat-1",
          workspaceId,
          providerId: "p1",
          modelId: "m1",
          messages: [{ role: "user", content: "hello" }],
        }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(200);
      expect(await res.text()).toBe("stream");
    });
  });

  describe("DELETE /:chatId", () => {
    it("should delete chat", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]); // requireWorkspaceAccess

      mockDb.returning.mockResolvedValueOnce([{ id: "chat-1" }]);

      const res = await app.request(`${baseUrl}/chat-1`, {
        method: "DELETE",
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        message: "Chat deleted successfully",
      });
    });
  });

  describe("PUT /:chatId", () => {
    it("should update chat", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]); // requireWorkspaceAccess

      const mockChat = { id: "chat-1", title: "Updated Title" };
      mockDb.returning.mockResolvedValueOnce([mockChat]);

      const res = await app.request(`${baseUrl}/chat-1`, {
        method: "PUT",
        body: JSON.stringify({
          title: "Updated Title",
          workspaceId,
          isPinned: true,
        }),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(mockChat);
    });
  });

  describe("POST /:chatId/generate-metadata", () => {
    it("should generate metadata", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]); // requireWorkspaceAccess

      // Fetch chat
      mockDb.limit.mockResolvedValueOnce([{ id: "chat-1", messages: [] }]);
      // Fetch workspace (no task model provider override)
      mockDb.limit.mockResolvedValueOnce([
        { id: workspaceId, taskModelProviderId: null },
      ]);
      // Fetch provider
      mockDb.limit.mockResolvedValueOnce([
        {
          id: "p1",
          providerType: "OpenAI",
          taskModelId: "m1",
          modelIds: ["m1"],
        },
      ]);

      const mockUpdatedChat = {
        id: "chat-1",
        title: "Generated Title",
        tags: ["tag1", "tag2"],
      };
      mockDb.returning.mockResolvedValueOnce([mockUpdatedChat]);

      const res = await app.request(`${baseUrl}/chat-1/generate-metadata`, {
        method: "POST",
        body: JSON.stringify({ providerId: "p1" }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(mockUpdatedChat);
    });

    it("should use workspace taskModelProviderId when set", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]); // requireWorkspaceAccess

      // Fetch chat
      mockDb.limit.mockResolvedValueOnce([{ id: "chat-1", messages: [] }]);
      // Fetch workspace (with task model provider override)
      mockDb.limit.mockResolvedValueOnce([
        { id: workspaceId, taskModelProviderId: "p2" },
      ]);
      // Fetch provider - should use p2 from workspace, not p1 from request
      mockDb.limit.mockResolvedValueOnce([
        {
          id: "p2",
          providerType: "OpenAI",
          taskModelId: "m2",
          modelIds: ["m2"],
        },
      ]);

      const mockUpdatedChat = {
        id: "chat-1",
        title: "Generated Title",
        tags: ["tag1", "tag2"],
      };
      mockDb.returning.mockResolvedValueOnce([mockUpdatedChat]);

      const res = await app.request(`${baseUrl}/chat-1/generate-metadata`, {
        method: "POST",
        body: JSON.stringify({ providerId: "p1" }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(mockUpdatedChat);
    });
  });
});
