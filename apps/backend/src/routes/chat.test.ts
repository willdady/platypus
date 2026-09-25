import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  mockDb,
  mockNoSession,
  mockSession,
  resetMockDb,
  seedDb,
  useTempDiskStorage,
  putStoredFiles,
  isStored,
  type Row,
  type Store,
} from "../test-utils.ts";
import { mockLogger } from "../test-setup.ts";
import { getStorage } from "../storage/index.ts";

const { mockPrepareChatTurn, mockValidateTurnAttachments } = vi.hoisted(() => ({
  mockPrepareChatTurn: vi.fn(),
  mockValidateTurnAttachments: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../services/chat-execution.ts", () => ({
  prepareChatTurn: mockPrepareChatTurn,
  validateTurnAttachments: mockValidateTurnAttachments,
  drizzleChatTurnQueries: {},
}));

import { createUIMessageStreamResponse, streamText } from "ai";
import app from "../server.ts";
import { runRegistry } from "../runs/run-registry.ts";
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

/** A row of `chat_message`, in `chat-1`. */
const stored = (
  id: string,
  parentId: string | null,
  role: "user" | "assistant",
  seconds: number,
  extra: Row = {},
): Row => ({
  chatId: "chat-1",
  id,
  parentId,
  role,
  parts: [{ type: "text", text: id }],
  metadata: null,
  deletedAt: null,
  createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)),
  ...extra,
});

/** user-1 as the owner of ws-1, plus whatever the test adds. */
const seedTenant = (rows: Store = {}, owner = "user-1") =>
  seedDb({
    organization_member: [
      { id: "m1", userId: "user-1", organizationId: "org-1", role: "admin" },
    ],
    workspace: [{ id: "ws-1", organizationId: "org-1", ownerId: owner }],
    ...rows,
  });

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
  const hello = {
    id: "u1",
    role: "user",
    parts: [{ type: "text", text: "hello" }],
  };

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
    it("returns the Active path and the tree, and nothing internal", async () => {
      mockSession();
      seedTenant({
        chat: [
          {
            id: "chat-1",
            workspaceId,
            title: "Chat 1",
            activeLeafId: "a1",
            memoryCursorId: "a1",
            memorySnapshot: "pinned",
            lastTurnAt: new Date(),
          },
        ],
        chat_message: [
          stored("u1", null, "user", 1, {
            parts: [
              {
                type: "file",
                mediaType: "image/png",
                url: "storage://org-1/ws-1/chat-1/u1/0-aaaaaaaa.png",
              },
            ],
          }),
          stored("a1", "u1", "assistant", 2),
          stored("a1b", "u1", "assistant", 3),
          stored("a1c", "u1", "assistant", 4, { deletedAt: new Date() }),
        ],
      });

      const res = await app.request(`${baseUrl}/chat-1`);

      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toMatchObject({ id: "chat-1", title: "Chat 1" });
      expect(body.messages).toEqual([
        {
          id: "u1",
          role: "user",
          parts: [
            {
              type: "file",
              mediaType: "image/png",
              url: "http://localhost/files/org-1/ws-1/chat-1/u1/0-aaaaaaaa.png",
            },
          ],
        },
        { id: "a1", role: "assistant", parts: [{ type: "text", text: "a1" }] },
      ]);
      expect(body.tree).toEqual([
        { id: "u1", parentId: null },
        { id: "a1", parentId: "u1" },
        { id: "a1b", parentId: "u1" },
      ]);
      expect(body).not.toHaveProperty("activeLeafId");
      expect(body).not.toHaveProperty("memoryCursorId");
      expect(body).not.toHaveProperty("memorySnapshot");
      expect(body).not.toHaveProperty("lastTurnAt");
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

    /**
     * The `ai` mock hands out ONE `ReadableStream` and ONE `Response`, and both
     * are consumed on the way through the drive — so the second test to reach
     * the drive finds them locked. A test that needs the run to get that far
     * re-stubs both with instances of its own.
     */
    const freshStream = () => {
      vi.mocked(streamText).mockReturnValueOnce({
        toUIMessageStream: () =>
          new ReadableStream({
            start(controller) {
              controller.close();
            },
          }),
      } as unknown as ReturnType<typeof streamText>);
      vi.mocked(createUIMessageStreamResponse).mockReturnValueOnce(
        new Response("stream"),
      );
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
      mockDb.orderBy.mockResolvedValueOnce([]); // the path it continues: none

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
          message: hello,
          parentId: null,
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
      mockDb.orderBy.mockResolvedValueOnce([]); // the path it continues: none
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
          message: hello,
          parentId: null,
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
      mockDb.orderBy.mockResolvedValueOnce([]); // the path it continues: none
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
          message: hello,
          parentId: null,
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
      mockDb.orderBy.mockResolvedValueOnce([]); // the path it continues: none

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
          message: hello,
          parentId: null,
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
      mockDb.orderBy.mockResolvedValueOnce([]); // the path it continues: none
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
          message: hello,
          parentId: null,
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
      mockDb.limit.mockResolvedValueOnce([]); // the message id is not taken
      mockDb.orderBy.mockResolvedValueOnce([]); // the path it continues: none
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
          message: hello,
          parentId: null,
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

    // A user-invoked Skill (issue #649). Seeded onto the messages that reach
    // `prepareChatTurn` — the array the run also persists — rather than onto the
    // converted model messages, which would reach the model and persist nothing.
    it("seeds a loadSkill pair for a message that opens with a slash command", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]); // requireOrgAccess
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]); // requireWorkspaceAccess
      mockDb.limit.mockResolvedValueOnce([]); // ADR-0020 row lookup (new chat)
      mockDb.orderBy.mockResolvedValueOnce([]); // the path it continues: none
      mockDb.limit.mockResolvedValueOnce([
        { id: "agent-1", workspaceId, skillIds: ["skill-1"] },
      ]); // the turn's Agent, for its assigned Skills
      mockDb.limit.mockResolvedValueOnce([
        {
          id: "skill-1",
          workspaceId,
          name: "blog-post",
          body: "Write a blog post.",
          // User-invocable only, so the model's catalogue excludes it — and the
          // user invoking it by name must still work (#713).
          disableModelInvocation: true,
        },
      ]); // the named Skill
      mockDb.returning.mockResolvedValueOnce([{ id: "chat-cmd" }]);
      mockPrepareChatTurn.mockResolvedValueOnce(validTurn);
      freshStream();

      const res = await app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify({
          id: "chat-cmd",
          workspaceId,
          agentId: "agent-1",
          message: {
            id: "u1",
            role: "user",
            parts: [{ type: "text", text: "/blog-post about otters" }],
          },
          parentId: null,
        }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(200);

      const inputArg = mockPrepareChatTurn.mock.calls[0][0] as {
        messages: Array<{
          role: string;
          parts: Array<Record<string, unknown>>;
        }>;
      };
      expect(inputArg.messages).toHaveLength(2);
      // The user's message still carries the token, so the transcript shows it.
      expect(inputArg.messages[0].parts[0]).toEqual({
        type: "text",
        text: "/blog-post about otters",
      });
      // Trailing assistant, so the SDK folds the reply into this same message —
      // one bubble with a loadSkill card above the answer, not two.
      expect(inputArg.messages[1].role).toBe("assistant");
      expect(inputArg.messages[1].parts[0]).toMatchObject({
        type: "tool-loadSkill",
        state: "output-available",
        input: { name: "blog-post" },
        output: { name: "blog-post", body: "Write a blog post." },
      });
    });

    it("sends an unresolvable command as ordinary text", async () => {
      mockSession();
      mockDb.limit.mockResolvedValueOnce([{ role: "member" }]);
      mockDb.limit.mockResolvedValueOnce([
        { ownerId: "user-1", organizationId: "org-1" },
      ]);
      mockDb.limit.mockResolvedValueOnce([]);
      mockDb.orderBy.mockResolvedValueOnce([]); // the path it continues: none
      mockDb.limit.mockResolvedValueOnce([
        { id: "agent-1", workspaceId, skillIds: ["skill-1"] },
      ]);
      // No Skill of that name in either scope, and no Attachment either.
      mockDb.limit.mockResolvedValue([]);
      mockDb.returning.mockResolvedValueOnce([{ id: "chat-typo" }]);
      mockPrepareChatTurn.mockResolvedValueOnce(validTurn);
      freshStream();

      const res = await app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify({
          id: "chat-typo",
          workspaceId,
          agentId: "agent-1",
          message: {
            id: "u1",
            role: "user",
            parts: [{ type: "text", text: "/usr/bin/env is broken" }],
          },
          parentId: null,
        }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(200);
      const inputArg = mockPrepareChatTurn.mock.calls[0][0] as {
        messages: unknown[];
      };
      expect(inputArg.messages).toHaveLength(1);
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

    describe("stored files", () => {
      useTempDiskStorage();

      // Neither file is on the Chat's Active path: the first is on an
      // Alternative an edit left behind, the second on a deleted message.
      const orphan = "org-1/ws-1/chat-1/u1-edited/0-aaaaaaaa.png";
      const deleted = "org-1/ws-1/chat-1/u2/0-cccccccc.png";
      const sibling = "org-1/ws-1/chat-10/msg-1/0-bbbbbbbb.png";
      const withFile = (key: string) => [
        { type: "file", mediaType: "image/png", url: `storage://${key}` },
      ];

      const seed = () =>
        seedDb({
          organization_member: [
            {
              id: "m1",
              userId: "user-1",
              organizationId: orgId,
              role: "member",
            },
          ],
          workspace: [
            { id: workspaceId, organizationId: orgId, ownerId: "user-1" },
          ],
          chat: [
            { id: "chat-1", workspaceId, activeLeafId: "u1" },
            { id: "chat-10", workspaceId, activeLeafId: null },
          ],
          chat_message: [
            { chatId: "chat-1", id: "u1", parentId: null, role: "user" },
            {
              chatId: "chat-1",
              id: "u1-edited",
              parentId: null,
              role: "user",
              parts: withFile(orphan),
            },
            {
              chatId: "chat-1",
              id: "u2",
              parentId: "u1",
              role: "user",
              parts: withFile(deleted),
              deletedAt: new Date(),
            },
          ],
        });

      it("removes everything under the Chat's prefix and nothing under a sibling's", async () => {
        mockSession();
        const fake = seed();
        await putStoredFiles([orphan, deleted, sibling]);

        const res = await app.request(`${baseUrl}/chat-1`, {
          method: "DELETE",
        });

        expect(res.status).toBe(200);
        expect(fake.tables.chat.map((row) => row.id)).toEqual(["chat-10"]);
        expect(await isStored(orphan)).toBe(false);
        expect(await isStored(deleted)).toBe(false);
        expect(await isStored(sibling)).toBe(true);
      });

      it("leaves storage untouched when the row delete fails", async () => {
        mockSession();
        const fake = seed();
        await putStoredFiles([orphan]);
        vi.spyOn(
          fake.handle as { delete: () => never },
          "delete",
        ).mockImplementation(() => {
          throw new Error("db down");
        });

        const res = await app.request(`${baseUrl}/chat-1`, {
          method: "DELETE",
        });

        expect(res.status).toBe(500);
        expect(await isStored(orphan)).toBe(true);
      });

      it("still succeeds, and logs, when storage fails after the row delete", async () => {
        mockSession();
        const fake = seed();
        vi.spyOn(getStorage(), "deletePrefix").mockRejectedValue(
          new Error("storage down"),
        );

        const res = await app.request(`${baseUrl}/chat-1`, {
          method: "DELETE",
        });

        expect(res.status).toBe(200);
        expect(fake.tables.chat.map((row) => row.id)).toEqual(["chat-10"]);
        expect(mockLogger.error).toHaveBeenCalledWith(
          expect.objectContaining({ prefix: "org-1/ws-1/chat-1/" }),
          "Failed to delete files from storage",
        );
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

  describe("the server-owned Transcript (ADR-0026)", () => {
    const validTurn = {
      stream: { model: {}, tools: {}, system: "", messages: [], maxSteps: 1 },
      resolved: { providerId: "p1", modelId: "m1" },
      dispose: vi.fn().mockResolvedValue(undefined),
    };

    /** A fresh stream per request: the `ai` mock's one instance locks. */
    const startsTurn = () => {
      vi.mocked(streamText).mockReturnValueOnce({
        toUIMessageStream: () =>
          new ReadableStream({
            start(controller) {
              controller.close();
            },
          }),
      } as unknown as ReturnType<typeof streamText>);
      vi.mocked(createUIMessageStreamResponse).mockReturnValueOnce(
        new Response("stream"),
      );
      mockPrepareChatTurn.mockResolvedValueOnce(validTurn);
    };

    const post = async (body: Record<string, unknown>) => {
      const res = await app.request(baseUrl, {
        method: "POST",
        body: JSON.stringify({
          id: "chat-1",
          workspaceId,
          providerId: "p1",
          modelId: "m1",
          ...body,
        }),
        headers: { "Content-Type": "application/json" },
      });
      // The run outlives the response; let it release the Chat.
      await vi.waitFor(() => expect(runRegistry.has("chat-1")).toBe(false));
      return res;
    };

    const deleteMessage = (id: string) =>
      app.request(`${baseUrl}/chat-1/messages/${id}`, { method: "DELETE" });

    const message = (id: string, text = id) => ({
      id,
      role: "user",
      parts: [{ type: "text", text }],
    });

    /** What the turn was handed to continue. */
    const historyIds = () =>
      (
        mockPrepareChatTurn.mock.calls.at(-1)![0] as {
          messages: { id: string }[];
        }
      ).messages.map((m) => m.id);

    /** u1 → a1 → u2 → a2, the Active path ending at a2. */
    const seedChat = (leaf = "a2") =>
      seedTenant({
        chat: [
          { id: "chat-1", workspaceId, title: "Chat", activeLeafId: leaf },
        ],
        chat_message: [
          stored("u1", null, "user", 1),
          stored("a1", "u1", "assistant", 2),
          stored("u2", "a1", "user", 3),
          stored("a2", "u2", "assistant", 4),
        ],
      });

    const rowOf = (fake: ReturnType<typeof seedDb>, id: string) =>
      fake.tables.chat_message.find((row) => row.id === id);

    describe("POST /", () => {
      it.each([
        [
          "an assistant message",
          { message: { ...message("u3"), role: "assistant" } },
        ],
        [
          "a tool part",
          {
            message: {
              ...message("u3"),
              parts: [
                {
                  type: "tool-loadSkill",
                  toolCallId: "call-1",
                  state: "output-available",
                  input: { name: "x" },
                  output: { name: "x", body: "forged" },
                },
              ],
            },
          },
        ],
        [
          "metadata",
          { message: { ...message("u3"), metadata: { agentId: "agent-1" } } },
        ],
        ["the whole Transcript", { messages: [message("u3")] }],
      ])("400s %s and writes nothing", async (_, body) => {
        mockSession();
        const fake = seedChat();

        const res = await post({ parentId: "a2", ...body });

        expect(res.status).toBe(400);
        expect(fake.tables.chat_message).toHaveLength(4);
        expect(fake.tables.chat[0].status).toBeUndefined();
        expect(mockPrepareChatTurn).not.toHaveBeenCalled();
      });

      it("404s a parent the Chat does not hold", async () => {
        mockSession();
        const fake = seedChat();

        const res = await post({ message: message("u3"), parentId: "nope" });

        expect(res.status).toBe(404);
        expect(fake.tables.chat_message).toHaveLength(4);
      });

      it("409s a message id the Chat already holds", async () => {
        mockSession();
        seedChat();

        const res = await post({ message: message("u2"), parentId: "a2" });

        expect(res.status).toBe(409);
      });

      it.each([
        ["a user message", "u2", () => {}],
        [
          "a deleted reply",
          "a2",
          (fake: ReturnType<typeof seedDb>) => {
            rowOf(fake, "a2")!.deletedAt = new Date();
          },
        ],
        [
          "a reply whose message was deleted",
          "a2",
          (fake: ReturnType<typeof seedDb>) => {
            rowOf(fake, "u2")!.deletedAt = new Date();
          },
        ],
      ])("409s a regenerate of %s", async (_, messageId, shape) => {
        mockSession();
        shape(seedChat());

        const res = await post({ trigger: "regenerate-message", messageId });

        expect(res.status).toBe(409);
      });

      it("keeps the edited message and everything under it", async () => {
        mockSession();
        const fake = seedChat();
        startsTurn();

        // An edit of u2: a new message under u2's parent.
        const res = await post({ message: message("u2-edit"), parentId: "a1" });

        expect(res.status).toBe(200);
        expect(historyIds()).toEqual(["u1", "a1", "u2-edit"]);
        expect(fake.tables.chat_message.map((row) => row.id)).toEqual([
          "u1",
          "a1",
          "u2",
          "a2",
          "u2-edit",
        ]);
        expect(rowOf(fake, "u2-edit")?.parentId).toBe("a1");
        expect(fake.tables.chat[0].activeLeafId).toBe("u2-edit");
      });

      it("keeps the regenerated reply and runs from its parent", async () => {
        mockSession();
        const fake = seedChat();
        startsTurn();

        const res = await post({
          trigger: "regenerate-message",
          messageId: "a2",
        });

        expect(res.status).toBe(200);
        expect(historyIds()).toEqual(["u1", "a1", "u2"]);
        expect(rowOf(fake, "a2")).toMatchObject({ deletedAt: null });
        // The stubbed stream ends before any reply, so the leaf goes back to
        // the reply it would have replaced rather than stranding it.
        expect(fake.tables.chat[0].activeLeafId).toBe("a2");
      });

      // Two tabs on one Chat. Tab 1 went on to u2 → a2; tab 2 still shows
      // u1 → a1 and sends from there.
      it("stores a stale tab's message as an Alternative on the path it held", async () => {
        mockSession();
        const fake = seedChat();
        startsTurn();

        const res = await post({ message: message("u2-tab2"), parentId: "a1" });

        expect(res.status).toBe(200);
        expect(historyIds()).toEqual(["u1", "a1", "u2-tab2"]);
        expect(rowOf(fake, "u2")).toBeDefined();
        expect(rowOf(fake, "a2")).toBeDefined();
        expect(rowOf(fake, "u2-tab2")?.parentId).toBe("a1");
      });

      it("stores it there even when that path's last message was deleted in the other tab", async () => {
        mockSession();
        const fake = seedChat();
        expect((await deleteMessage("a2")).status).toBe(200); // tab 1
        startsTurn();

        const res = await post({ message: message("u3"), parentId: "a2" }); // tab 2

        expect(res.status).toBe(200);
        expect(historyIds()).toEqual(["u1", "a1", "u2", "u3"]);
        expect(rowOf(fake, "u3")?.parentId).toBe("a2");
        expect(fake.tables.chat_message).toHaveLength(5);
      });

      it("seeds the Skill again when regenerating a reply to a /skill message", async () => {
        mockSession();
        seedTenant({
          chat: [
            { id: "chat-1", workspaceId, title: "Chat", activeLeafId: "a1" },
          ],
          chat_message: [
            stored("u1", null, "user", 1, {
              parts: [{ type: "text", text: "/blog-post about otters" }],
            }),
            stored("a1", "u1", "assistant", 2),
          ],
          agent: [
            {
              id: "agent-1",
              workspaceId,
              organizationId: null,
              skillIds: ["skill-1"],
            },
          ],
          skill: [
            {
              id: "skill-1",
              workspaceId,
              organizationId: null,
              name: "blog-post",
              body: "Write a blog post.",
            },
          ],
        });
        startsTurn();

        const res = await post({
          providerId: undefined,
          modelId: undefined,
          agentId: "agent-1",
          trigger: "regenerate-message",
          messageId: "a1",
        });

        expect(res.status).toBe(200);
        const history = (
          mockPrepareChatTurn.mock.calls[0][0] as {
            messages: { id: string; role: string; parts: unknown[] }[];
          }
        ).messages;
        expect(history.map((m) => m.role)).toEqual(["user", "assistant"]);
        // A new seeded message, not the old reply: the reply it continues
        // gets a new id and a1 stays as it was.
        expect(history[1].id).not.toBe("a1");
        expect(history[1].parts[0]).toMatchObject({
          type: "tool-loadSkill",
          output: { name: "blog-post", body: "Write a blog post." },
        });
      });
    });

    describe("DELETE /:chatId/messages/:messageId", () => {
      it("takes the message out of the Chat for good, with no further send", async () => {
        mockSession();
        seedChat();

        const res = await deleteMessage("u2");

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ message: "Message deleted" });
        const reloaded = (await (
          await app.request(`${baseUrl}/chat-1`)
        ).json()) as { messages: { id: string }[] };
        expect(reloaded.messages.map((m) => m.id)).toEqual(["u1", "a1", "a2"]);
      });

      it("leaves it out of what the next turn sends the model", async () => {
        mockSession();
        seedChat();
        await deleteMessage("u2");
        startsTurn();

        await post({ message: message("u3"), parentId: "a2" });

        expect(historyIds()).toEqual(["u1", "a1", "a2", "u3"]);
      });

      it("is idempotent", async () => {
        mockSession();
        seedChat();

        expect((await deleteMessage("u2")).status).toBe(200);
        expect((await deleteMessage("u2")).status).toBe(200);
      });

      it("404s a message the Chat does not hold", async () => {
        mockSession();
        seedChat();

        expect((await deleteMessage("nope")).status).toBe(404);
      });

      it("409s while a run is in flight", async () => {
        mockSession();
        const fake = seedChat();
        runRegistry.register("chat-1");
        try {
          expect((await deleteMessage("u2")).status).toBe(409);
          expect(rowOf(fake, "u2")?.deletedAt).toBeNull();
        } finally {
          runRegistry.unregister("chat-1");
        }
      });

      it("is refused to anyone but the Workspace Owner", async () => {
        mockSession();
        const fake = seedTenant(
          {
            chat: [{ id: "chat-1", workspaceId, activeLeafId: "u1" }],
            chat_message: [stored("u1", null, "user", 1)],
          },
          "user-2",
        );

        expect((await deleteMessage("u1")).status).toBe(403);
        expect(rowOf(fake, "u1")?.deletedAt).toBeNull();
      });
    });

    describe("PUT /:chatId/active-leaf", () => {
      const switchTo = (messageId: string) =>
        app.request(`${baseUrl}/chat-1/active-leaf`, {
          method: "PUT",
          body: JSON.stringify({ messageId }),
          headers: { "Content-Type": "application/json" },
        });

      /**
       * u1 → a1 → u2 → a2 → u3 → a3, with u2 edited (u2b → a2b, the Active
       * path) and a2 regenerated (a2c) in between.
       */
      const seedAlternatives = () =>
        seedTenant({
          chat: [
            { id: "chat-1", workspaceId, title: "Chat", activeLeafId: "a2b" },
          ],
          chat_message: [
            stored("u1", null, "user", 1),
            stored("a1", "u1", "assistant", 2),
            stored("u2", "a1", "user", 3),
            stored("a2", "u2", "assistant", 4),
            stored("u2b", "a1", "user", 5),
            stored("a2b", "u2b", "assistant", 6),
            stored("a2c", "u2", "assistant", 7),
            stored("u3", "a2", "user", 8),
            stored("a3", "u3", "assistant", 9),
          ],
        });

      type Path = { messages: { id: string }[]; tree: unknown[] };
      const ids = (body: unknown) => (body as Path).messages.map((m) => m.id);

      it("lands on the newest message under the one chosen, however deep", async () => {
        mockSession();
        const fake = seedAlternatives();

        const res = await switchTo("u2");

        expect(res.status).toBe(200);
        const body = (await res.json()) as Path;
        expect(ids(body)).toEqual(["u1", "a1", "u2", "a2", "u3", "a3"]);
        expect(body.tree).toHaveLength(9);
        expect(fake.tables.chat[0].activeLeafId).toBe("a3");
      });

      it("lands on the message itself when nothing follows it", async () => {
        mockSession();
        seedAlternatives();

        expect(ids(await (await switchTo("a2c")).json())).toEqual([
          "u1",
          "a1",
          "u2",
          "a2c",
        ]);
      });

      it("survives a reload", async () => {
        mockSession();
        seedAlternatives();
        await switchTo("u2");

        const reloaded: unknown = await (
          await app.request(`${baseUrl}/chat-1`)
        ).json();

        expect(ids(reloaded)).toEqual(["u1", "a1", "u2", "a2", "u3", "a3"]);
      });

      it("skips a deleted message when choosing where to land", async () => {
        mockSession();
        const fake = seedAlternatives();
        rowOf(fake, "a3")!.deletedAt = new Date();

        const res = await switchTo("u2");

        expect(ids(await res.json())).toEqual(["u1", "a1", "u2", "a2", "u3"]);
        expect(fake.tables.chat[0].activeLeafId).toBe("u3");
      });

      it("reaches a message under a deleted one", async () => {
        mockSession();
        const fake = seedAlternatives();
        rowOf(fake, "u3")!.deletedAt = new Date();

        const res = await switchTo("u2");

        expect(ids(await res.json())).toEqual(["u1", "a1", "u2", "a2", "a3"]);
      });

      it.each([
        ["a message the Chat does not hold", "nope", () => {}],
        [
          "a deleted message",
          "u2",
          (fake: ReturnType<typeof seedDb>) => {
            rowOf(fake, "u2")!.deletedAt = new Date();
          },
        ],
      ])("404s %s and leaves the path", async (_, messageId, shape) => {
        mockSession();
        const fake = seedAlternatives();
        shape(fake);

        const res = await switchTo(messageId);

        expect(res.status).toBe(404);
        expect(await res.json()).toHaveProperty("error");
        expect(fake.tables.chat[0].activeLeafId).toBe("a2b");
      });

      it("409s while a run is in flight", async () => {
        mockSession();
        const fake = seedAlternatives();
        runRegistry.register("chat-1");
        try {
          const res = await switchTo("u2");
          expect(res.status).toBe(409);
          expect(await res.json()).toHaveProperty("error");
          expect(fake.tables.chat[0].activeLeafId).toBe("a2b");
        } finally {
          runRegistry.unregister("chat-1");
        }
      });

      it("is refused to anyone but the Workspace Owner", async () => {
        mockSession();
        const fake = seedTenant(
          {
            chat: [{ id: "chat-1", workspaceId, activeLeafId: "u1b" }],
            chat_message: [
              stored("u1", null, "user", 1),
              stored("u1b", null, "user", 2),
            ],
          },
          "user-2",
        );

        expect((await switchTo("u1")).status).toBe(403);
        expect(fake.tables.chat[0].activeLeafId).toBe("u1b");
      });
    });
  });
});
