import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  mockDb,
  mockNoSession,
  mockSession,
  resetMockDb,
} from "../test-utils.ts";

const { mockPrepareChatTurn, mockValidateTurnAttachments } = vi.hoisted(() => ({
  mockPrepareChatTurn: vi.fn(),
  mockValidateTurnAttachments: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../services/chat-execution.ts", () => ({
  prepareChatTurn: mockPrepareChatTurn,
  validateTurnAttachments: mockValidateTurnAttachments,
  drizzleChatTurnQueries: {},
}));

import app from "../server.ts";
import { NotFoundError, ValidationError } from "../errors.ts";
import { FileValidationError } from "../services/file-gate.ts";
import {
  retrieveRecentSummaries,
  formatSummariesForSystemPrompt,
  resolveMemoryPin,
  type MemorySummary,
} from "../services/memory-retrieval.ts";

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
  resolveMemoryPin: vi.fn().mockReturnValue({ reuse: false }),
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
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]); // requireWorkspaceAccess

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
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]); // requireWorkspaceAccess

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
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]); // requireWorkspaceAccess

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
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]); // requireWorkspaceAccess

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
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]); // requireWorkspaceAccess

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
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]); // requireWorkspaceAccess

      const mockChat = { id: "chat-1", title: "Chat 1" };
      mockDb.limit.mockResolvedValueOnce([mockChat]);

      const res = await app.request(`${baseUrl}/chat-1`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(mockChat);
    });
  });

  describe("POST /", () => {
    // A stream-shaped turn the route can route into streamText without
    // exercising prepareChatTurn's internals (covered by chat-execution.test.ts).
    const validTurn = {
      stream: { model: {}, tools: {}, system: "", messages: [], maxSteps: 1 },
      resolved: { providerId: "p1", modelId: "m1" },
      dispose: vi.fn().mockResolvedValue(undefined),
    };

    it("should start a chat stream", async () => {
      mockSession({
        id: "user-1",
        name: "Test User",
        email: "test@example.com",
      });
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]); // requireWorkspaceAccess
      mockDb.limit.mockResolvedValueOnce([]); // ADR-0020 row lookup (new chat)

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

    it("maps a NotFoundError from prepareChatTurn to 404 via the central onError seam", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]); // requireWorkspaceAccess
      mockDb.limit.mockResolvedValueOnce([]); // ADR-0020 row lookup (new chat)
      mockDb.returning.mockResolvedValueOnce([{ id: "chat-2" }]); // ChatSink.onStart

      mockPrepareChatTurn.mockRejectedValueOnce(
        new NotFoundError("Agent 'agent-1' not found"),
      );

      const res = await app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify({
          id: "chat-2",
          workspaceId,
          agentId: "agent-1",
          messages: [{ role: "user", content: "hello" }],
        }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({
        error: "Agent 'agent-1' not found",
      });
    });

    it("maps a ValidationError from prepareChatTurn to 400 via the central onError seam", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]); // requireWorkspaceAccess
      mockDb.limit.mockResolvedValueOnce([]); // ADR-0020 row lookup (new chat)
      mockDb.returning.mockResolvedValueOnce([{ id: "chat-3" }]); // ChatSink.onStart

      mockPrepareChatTurn.mockRejectedValueOnce(
        new ValidationError("Model id 'bogus' not enabled for provider 'p1'"),
      );

      const res = await app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify({
          id: "chat-3",
          workspaceId,
          providerId: "p1",
          modelId: "bogus",
          messages: [{ role: "user", content: "hello" }],
        }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: "Model id 'bogus' not enabled for provider 'p1'",
      });
    });

    it("maps a FileValidationError from the file gate to 400 with the offending files", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]); // requireWorkspaceAccess
      mockDb.limit.mockResolvedValueOnce([]); // ADR-0020 row lookup (new chat)

      const fileError = new FileValidationError([
        { file: "scan.pdf", reason: "unextractable" },
      ]);
      mockValidateTurnAttachments.mockRejectedValueOnce(fileError);

      const res = await app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify({
          id: "chat-4",
          workspaceId,
          providerId: "p1",
          modelId: "m1",
          messages: [{ role: "user", content: "hello" }],
        }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: fileError.message,
        files: ["scan.pdf"],
      });
    });

    it("re-takes and forwards a freshly resolved Memories snapshot on a stale pin (ADR-0020)", async () => {
      mockSession({
        id: "user-1",
        name: "Test User",
        email: "test@example.com",
      });
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]); // requireWorkspaceAccess
      mockDb.limit.mockResolvedValueOnce([]); // ADR-0020 row lookup (no row → new chat)
      mockDb.returning.mockResolvedValueOnce([{ id: "chat-a" }]); // ChatSink.onStart

      vi.mocked(resolveMemoryPin).mockReturnValueOnce({ reuse: false });
      vi.mocked(retrieveRecentSummaries).mockResolvedValueOnce([
        { id: "s1", summaryDate: "2026-04-29", summary: "Likes coffee." },
      ] as MemorySummary[]);
      vi.mocked(formatSummariesForSystemPrompt).mockReturnValueOnce(
        "pinned-fresh",
      );
      mockPrepareChatTurn.mockResolvedValueOnce(validTurn);

      await app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify({
          id: "chat-a",
          workspaceId,
          providerId: "p1",
          modelId: "m1",
          messages: [],
        }),
        headers: { "Content-Type": "application/json" },
      });

      const inputArg = mockPrepareChatTurn.mock.calls[0][0] as {
        memorySnapshot?: string;
      };
      // The resolved block rides down through RunInput into prepareChatTurn.
      expect(inputArg.memorySnapshot).toBe("pinned-fresh");
      // The window is anchored to the re-take moment, not a clock read. Its
      // span is not a call-site argument — the retrieval owns it.
      expect(retrieveRecentSummaries).toHaveBeenCalledWith(
        "user-1",
        "ws-1",
        expect.any(Date),
      );
    });

    it("reuses the pinned snapshot when the Chat has not idled past the horizon (ADR-0020)", async () => {
      mockSession({
        id: "user-1",
        name: "Test User",
        email: "test@example.com",
      });
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]); // requireWorkspaceAccess
      // Row lookup resolves an existing Chat carrying a pin and a previous-turn
      // stamp.
      mockDb.limit.mockResolvedValueOnce([
        { memorySnapshot: "pinned-block", lastTurnAt: new Date() },
      ]);
      mockDb.returning.mockResolvedValueOnce([{ id: "chat-b" }]); // ChatSink.onStart

      vi.mocked(resolveMemoryPin).mockReturnValueOnce({
        reuse: true,
        block: "pinned-block",
      });

      mockPrepareChatTurn.mockResolvedValueOnce(validTurn);

      await app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify({
          id: "chat-b",
          workspaceId,
          providerId: "p1",
          modelId: "m1",
          messages: [],
        }),
        headers: { "Content-Type": "application/json" },
      });

      const inputArg = mockPrepareChatTurn.mock.calls[0][0] as {
        memorySnapshot?: string;
      };
      // The existing pin is forwarded verbatim — the prefix stays byte-identical.
      expect(inputArg.memorySnapshot).toBe("pinned-block");
      expect(retrieveRecentSummaries).not.toHaveBeenCalled();
    });
  });

  describe("DELETE /:chatId", () => {
    it("should delete chat", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]); // requireWorkspaceAccess

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
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]); // requireWorkspaceAccess
      // chat row lookup
      mockDb.limit.mockResolvedValueOnce([{ id: "chat-1" }]);

      const res = await app.request(`${baseUrl}/chat-1/cancel`, {
        method: "POST",
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.message).toMatch(/cancel/i);
    });

    it("returns 200 when called twice (idempotent)", async () => {
      for (let i = 0; i < 2; i++) {
        mockSession();
        mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
        mockDb.limit.mockResolvedValueOnce([
          { ownerId: "user-1", organizationId: "org-1" },
        ]);
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
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]);
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
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]); // requireWorkspaceAccess

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
});
