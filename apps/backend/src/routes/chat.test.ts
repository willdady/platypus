import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockDb, mockSession, resetMockDb } from "../test-utils.ts";
import app from "../server.ts";

// Mock AI SDK
vi.mock("ai", async () => {
  const actual = await vi.importActual("ai");
  return {
    ...actual,
    streamText: vi.fn().mockReturnValue({
      toUIMessageStreamResponse: vi.fn().mockReturnValue(new Response("stream")),
    }),
    generateObject: vi.fn().mockResolvedValue({
      object: { title: "Generated Title", tags: ["tag1", "tag2"] },
    }),
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
  const baseUrl = `/organisations/${orgId}/workspaces/${workspaceId}/chat`;

  describe("GET /", () => {
    it("should list chats", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ role: "viewer" }]); // requireWorkspaceAccess
      
      const mockChats = [{ id: "chat-1", title: "Chat 1" }];
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
      mockDb.limit.mockResolvedValueOnce([{ role: "viewer" }]); // requireWorkspaceAccess
      
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
      mockDb.limit.mockResolvedValueOnce([{ role: "viewer" }]); // requireWorkspaceAccess
      
      const mockChat = { id: "chat-1", title: "Chat 1" };
      mockDb.limit.mockResolvedValueOnce([mockChat]);

      const res = await app.request(`${baseUrl}/chat-1`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(mockChat);
    });
  });

  describe("POST /", () => {
    it("should start a chat stream", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ role: "viewer" }]); // requireWorkspaceAccess
      
      // resolveChatContext: fetch provider
      mockDb.limit.mockResolvedValueOnce([{ 
        id: "p1", 
        providerType: "OpenAI", 
        modelIds: ["m1"],
        workspaceId
      }]);

      const res = await app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify({
          id: "chat-1",
          workspaceId,
          providerId: "p1",
          modelId: "m1",
          messages: [{ role: "user", content: "hello" }]
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
      mockDb.limit.mockResolvedValueOnce([{ role: "viewer" }]); // requireWorkspaceAccess
      
      mockDb.returning.mockResolvedValueOnce([{ id: "chat-1" }]);

      const res = await app.request(`${baseUrl}/chat-1`, {
        method: "DELETE",
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ message: "Chat deleted successfully" });
    });
  });

  describe("PUT /:chatId", () => {
    it("should update chat", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([{ role: "viewer" }]); // requireWorkspaceAccess
      
      const mockChat = { id: "chat-1", title: "Updated Title" };
      mockDb.returning.mockResolvedValueOnce([mockChat]);

      const res = await app.request(`${baseUrl}/chat-1`, {
        method: "PUT",
        body: JSON.stringify({
          title: "Updated Title",
          workspaceId,
          isStarred: true
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
      mockDb.limit.mockResolvedValueOnce([{ role: "viewer" }]); // requireWorkspaceAccess
      
      // Fetch chat
      mockDb.limit.mockResolvedValueOnce([{ id: "chat-1", messages: [] }]);
      // Fetch provider
      mockDb.limit.mockResolvedValueOnce([{ id: "p1", providerType: "OpenAI", taskModelId: "m1", modelIds: ["m1"] }]);
      
      const mockUpdatedChat = { id: "chat-1", title: "Generated Title", tags: ["tag1", "tag2"] };
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
