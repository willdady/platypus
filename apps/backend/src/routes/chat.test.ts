import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  mockDb,
  mockNoSession,
  mockSession,
  resetMockDb,
} from "../test-utils.ts";

const { mockPrepareChatTurn } = vi.hoisted(() => ({
  mockPrepareChatTurn: vi.fn(),
}));

vi.mock("../services/chat-execution.ts", () => {
  class ValidationError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "ValidationError";
    }
  }
  class NotFoundError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "NotFoundError";
    }
  }
  return {
    prepareChatTurn: mockPrepareChatTurn,
    ValidationError,
    NotFoundError,
    drizzleChatTurnQueries: {},
  };
});

import app from "../server.ts";

// Mock AI SDK
vi.mock("ai", async () => {
  const actual = await vi.importActual("ai");
  return {
    ...actual,
    streamText: vi.fn().mockReturnValue({
      toUIMessageStream: vi.fn().mockReturnValue(
        new ReadableStream({
          start(controller) {
            controller.close();
          },
        }),
      ),
    }),
    createUIMessageStreamResponse: vi
      .fn()
      .mockReturnValue(new Response("stream")),
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
  createOpenAI: vi
    .fn()
    .mockReturnValue(Object.assign(vi.fn(), { chat: vi.fn() })),
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
  retrieveRecentSummaries: vi.fn().mockResolvedValue([]),
  formatSummariesForSystemPrompt: vi.fn().mockReturnValue(""),
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
      // Skip .where() calls from middleware (orgAccess, workspaceAccess) and paginated query
      mockDb.where
        .mockReturnValueOnce(mockDb)
        .mockReturnValueOnce(mockDb)
        .mockReturnValueOnce(mockDb)
        .mockResolvedValueOnce([{ totalCount: 1 }]); // count query

      const res = await app.request(baseUrl);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ results: mockChats, totalCount: 1 });
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
      mockDb.where
        .mockReturnValueOnce(mockDb)
        .mockReturnValueOnce(mockDb)
        .mockReturnValueOnce(mockDb)
        .mockResolvedValueOnce([{ totalCount: 2 }]);

      const res = await app.request(`${baseUrl}?tags=typescript`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ results: mockChats, totalCount: 2 });
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
      mockDb.where
        .mockReturnValueOnce(mockDb)
        .mockReturnValueOnce(mockDb)
        .mockReturnValueOnce(mockDb)
        .mockResolvedValueOnce([{ totalCount: 3 }]);

      const res = await app.request(`${baseUrl}?tags=typescript,react`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ results: mockChats, totalCount: 3 });
    });

    it("should return empty array when tag filter has no matches", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]); // requireWorkspaceAccess

      mockDb.offset.mockResolvedValueOnce([]);
      mockDb.where
        .mockReturnValueOnce(mockDb)
        .mockReturnValueOnce(mockDb)
        .mockReturnValueOnce(mockDb)
        .mockResolvedValueOnce([{ totalCount: 0 }]);

      const res = await app.request(`${baseUrl}?tags=nonexistent-tag`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ results: [], totalCount: 0 });
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
      mockDb.where
        .mockReturnValueOnce(mockDb)
        .mockReturnValueOnce(mockDb)
        .mockReturnValueOnce(mockDb)
        .mockResolvedValueOnce([{ totalCount: 3 }]);

      const res = await app.request(baseUrl);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ results: mockChats, totalCount: 3 });
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

      // ChatSink.onStart upserts the chat row with status=running before
      // prepareChatTurn runs. Returning a non-empty array skips the insert
      // fallback path.
      mockDb.returning.mockResolvedValueOnce([{ id: "chat-1" }]);

      // The route under test does not exercise prepareChatTurn's internals —
      // chat-execution.test.ts covers those against an in-memory queries adapter. Here
      // we just stub it to a stream-shaped result so the route can wire up
      // streamText.
      mockPrepareChatTurn.mockResolvedValueOnce({
        stream: {
          model: {},
          tools: {},
          system: "",
          messages: [],
          maxSteps: 1,
        },
        resolved: {
          providerId: "p1",
          modelId: "m1",
        },
        dispose: vi.fn().mockResolvedValue(undefined),
      });

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

      // Mock for fetching chat record before delete (for file cleanup)
      mockDb.limit.mockResolvedValueOnce([{ id: "chat-1", messages: [] }]);

      const res = await app.request(`${baseUrl}/chat-1`, {
        method: "DELETE",
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        message: "Chat deleted successfully",
      });
    });
  });

  describe("POST /:chatId/cancel", () => {
    it("returns 200 when cancelling an existing chat (idempotent on inactive runs)", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]); // requireWorkspaceAccess
      // chat row lookup
      mockDb.limit.mockResolvedValueOnce([{ id: "chat-1" }]);

      const res = await app.request(`${baseUrl}/chat-1/cancel`, {
        method: "POST",
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.message).toMatch(/cancel/i);
    });

    it("returns 200 when called twice (idempotent)", async () => {
      for (let i = 0; i < 2; i++) {
        mockSession();
        mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
        mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]);
        mockDb.limit.mockResolvedValueOnce([{ id: "chat-1" }]);

        const res = await app.request(`${baseUrl}/chat-1/cancel`, {
          method: "POST",
        });
        expect(res.status).toBe(200);
      }
    });

    it("returns 404 when the chat does not belong to the workspace", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
      mockDb.limit.mockResolvedValueOnce([{ ownerId: "user-1" }]);
      mockDb.limit.mockResolvedValueOnce([]); // chat lookup misses

      const res = await app.request(`${baseUrl}/chat-other/cancel`, {
        method: "POST",
      });
      expect(res.status).toBe(404);
    });

    it("returns 401 without a session", async () => {
      mockNoSession();
      const res = await app.request(`${baseUrl}/chat-1/cancel`, {
        method: "POST",
      });
      expect(res.status).toBe(401);
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
      // Fetch existing tags
      mockDb.execute.mockResolvedValueOnce({ rows: [] });

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
      // Fetch existing tags
      mockDb.execute.mockResolvedValueOnce({ rows: [] });

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
