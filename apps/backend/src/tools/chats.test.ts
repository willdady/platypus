import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  callOkTool,
  callTool,
  resetMockDb,
  seedDb,
  type Row,
} from "../test-utils.ts";
import {
  CHAT_TRANSCRIPT_PAGE_MAX_BYTES,
  CHAT_TRANSCRIPT_PAGE_MAX_MESSAGES,
} from "@platypus/schemas";

const { mockStorageGet } = vi.hoisted(() => ({ mockStorageGet: vi.fn() }));

vi.mock("../storage/index.ts", () => ({
  getStorage: vi.fn(() => ({
    get: mockStorageGet,
  })),
}));

import { createChatTools } from "./chats.ts";

const workspaceId = "ws-1";

const at = (minutes: number) => new Date(Date.UTC(2026, 0, 1, 0, minutes));

const chatRow = (id: string, over: Row = {}): Row => ({
  id,
  workspaceId,
  title: id,
  status: "succeeded",
  isPinned: false,
  tags: [],
  activeLeafId: null,
  agentId: null,
  providerId: null,
  modelId: null,
  a2aClientName: null,
  triggerRunId: null,
  createdAt: at(0),
  updatedAt: at(0),
  lastTurnAt: at(0),
  ...over,
});

const messageRow = (
  chatId: string,
  id: string,
  parentId: string | null,
  role: "user" | "assistant",
  minute: number,
  parts: unknown[] = [{ type: "text", text: id }],
  over: Row = {},
): Row => ({
  chatId,
  id,
  parentId,
  role,
  parts,
  metadata: null,
  deletedAt: null,
  createdAt: at(minute),
  ...over,
});

const text = (value: string) => ({ type: "text", text: value });

const createTools = (sessionId = "chat-invoking") =>
  createChatTools(workspaceId, sessionId);

describe("createChatTools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStorageGet.mockReset();
    resetMockDb();
  });

  it("offers listChats and readTranscript", () => {
    expect(Object.keys(createTools())).toEqual(["listChats", "readTranscript"]);
  });

  describe("listChats", () => {
    /** A Workspace with an Agent chat, an ad-hoc chat, an A2A chat and a Trigger-run chat. */
    const seedChats = () =>
      seedDb({
        chat: [
          chatRow("chat-agent", {
            title: "Agent chat",
            agentId: "agent-1",
            tags: ["research"],
            lastTurnAt: at(4),
          }),
          chatRow("chat-adhoc", {
            title: "Ad-hoc chat",
            providerId: "provider-1",
            modelId: "gpt-5",
            lastTurnAt: at(3),
          }),
          chatRow("chat-a2a", {
            title: "A2A chat",
            a2aClientName: "Acme client",
            lastTurnAt: at(2),
          }),
          chatRow("chat-trigger", {
            title: "Nightly digest",
            triggerRunId: "run-1",
            tags: ["nightly"],
            lastTurnAt: at(1),
          }),
          chatRow("chat-other-workspace", {
            workspaceId: "ws-2",
            title: "Elsewhere",
            lastTurnAt: at(9),
          }),
        ],
        agent: [{ id: "agent-1", name: "Researcher" }],
        provider: [{ id: "provider-1", name: "OpenAI" }],
        trigger_run: [{ id: "run-1", triggerId: "trigger-1" }],
        trigger: [{ id: "trigger-1", name: "Nightly" }],
      });

    it("lists only this Workspace's Chats, newest activity first", async () => {
      seedChats();

      const result = await callOkTool(createTools().listChats, {});

      expect(result.chats.map((chat) => chat.id)).toEqual([
        "chat-agent",
        "chat-adhoc",
        "chat-a2a",
        "chat-trigger",
      ]);
    });

    it("puts a Chat that has never run after every Chat that has", async () => {
      seedDb({
        chat: [
          chatRow("chat-never-run", { lastTurnAt: null }),
          chatRow("chat-run", { lastTurnAt: at(1) }),
        ],
      });

      const { chats } = await callOkTool(createTools().listChats, {});

      expect(chats.map((chat) => chat.id)).toEqual([
        "chat-run",
        "chat-never-run",
      ]);
    });

    it("names an Agent, or the Provider and model for an ad-hoc Chat", async () => {
      seedChats();

      const { chats } = await callOkTool(createTools().listChats, {});

      expect(chats.find((chat) => chat.id === "chat-agent")).toMatchObject({
        agentName: "Researcher",
        tags: ["research"],
      });
      expect(chats.find((chat) => chat.id === "chat-adhoc")).toMatchObject({
        providerName: "OpenAI",
        modelId: "gpt-5",
      });
      expect(chats.find((chat) => chat.id === "chat-adhoc")).not.toHaveProperty(
        "agentName",
      );
    });

    it("marks a Trigger-run Chat with its Trigger and run, and an A2A Chat with its client", async () => {
      seedChats();

      const { chats } = await callOkTool(createTools().listChats, {});

      expect(chats.find((chat) => chat.id === "chat-trigger")).toMatchObject({
        triggerId: "trigger-1",
        triggerRunId: "run-1",
      });
      expect(chats.find((chat) => chat.id === "chat-a2a")).toMatchObject({
        a2aClientName: "Acme client",
      });
      expect(chats.find((chat) => chat.id === "chat-a2a")).not.toHaveProperty(
        "triggerId",
      );
    });

    it("filters by Agent, tag, Trigger and since", async () => {
      seedChats();
      const tools = createTools();

      expect(
        (await callOkTool(tools.listChats, { agentId: "agent-1" })).chats.map(
          (chat) => chat.id,
        ),
      ).toEqual(["chat-agent"]);

      expect(
        (await callOkTool(tools.listChats, { tag: "nightly" })).chats.map(
          (chat) => chat.id,
        ),
      ).toEqual(["chat-trigger"]);

      expect(
        (
          await callOkTool(tools.listChats, { triggerId: "trigger-1" })
        ).chats.map((chat) => chat.id),
      ).toEqual(["chat-trigger"]);

      expect(
        (
          await callOkTool(tools.listChats, {
            since: at(2).toISOString(),
          })
        ).chats.map((chat) => chat.id),
      ).toEqual(["chat-agent", "chat-adhoc", "chat-a2a"]);
    });

    it("pages with limit and offset", async () => {
      seedChats();
      const tools = createTools();

      const first = await callOkTool(tools.listChats, { limit: 2 });
      const second = await callOkTool(tools.listChats, {
        limit: 2,
        offset: 2,
      });

      expect(first.chats.map((chat) => chat.id)).toEqual([
        "chat-agent",
        "chat-adhoc",
      ]);
      expect(second.chats.map((chat) => chat.id)).toEqual([
        "chat-a2a",
        "chat-trigger",
      ]);
    });

    it("leaves out the invoking Chat", async () => {
      seedChats();

      const { chats } = await callOkTool(
        createTools("chat-agent").listChats,
        {},
      );

      expect(chats.map((chat) => chat.id)).not.toContain("chat-agent");
    });

    it("leaves out the invoking Trigger run's Chat", async () => {
      seedChats();

      const { chats } = await callOkTool(createTools("run-1").listChats, {});

      expect(chats.map((chat) => chat.id)).not.toContain("chat-trigger");
      expect(chats.map((chat) => chat.id)).toContain("chat-agent");
    });
  });

  describe("readTranscript", () => {
    const seedChat = (over: Row = {}, messages: Row[] = []) =>
      seedDb({
        chat: [
          chatRow("chat-1", {
            title: "Reading",
            agentId: "agent-1",
            activeLeafId: messages.at(-1)?.id ?? null,
            ...over,
          }),
          chatRow("chat-other-workspace", { workspaceId: "ws-2" }),
        ],
        agent: [{ id: "agent-1", name: "Researcher" }],
        provider: [{ id: "provider-1", name: "OpenAI" }],
        chat_message: messages,
      });

    it("is a not-found error for a Chat in another Workspace", async () => {
      seedChat();

      const result = await callTool(createTools().readTranscript, {
        chatId: "chat-other-workspace",
      });

      expect(result).toEqual({ error: "Chat not found" });
    });

    it("is a not-found error for a Chat that does not exist", async () => {
      seedChat();

      const result = await callTool(createTools().readTranscript, {
        chatId: "missing",
      });

      expect(result).toEqual({ error: "Chat not found" });
    });

    it("refuses to read its own Chat", async () => {
      seedChat();

      const result = await callTool(createTools("chat-1").readTranscript, {
        chatId: "chat-1",
      });

      expect(result).toEqual({
        error: "A Chat cannot read its own Transcript.",
      });
    });

    it("refuses to read its own Trigger run's Chat", async () => {
      seedChat({ triggerRunId: "run-1" }, [
        messageRow("chat-1", "u1", null, "user", 1),
      ]);

      const result = await callTool(createTools("run-1").readTranscript, {
        chatId: "chat-1",
      });

      expect(result).toEqual({
        error: "A Chat cannot read its own Transcript.",
      });
    });

    it("names the Chat and its Agent in the header", async () => {
      seedChat({}, [messageRow("chat-1", "u1", null, "user", 1)]);

      const result = await callOkTool(createTools().readTranscript, {
        chatId: "chat-1",
      });

      expect(result.chat).toMatchObject({
        id: "chat-1",
        title: "Reading",
        agentName: "Researcher",
        status: "succeeded",
      });
      expect(result.nextCursor).toBeNull();
    });

    it("names the Provider and model for an ad-hoc Chat", async () => {
      seedChat(
        {
          agentId: null,
          providerId: "provider-1",
          modelId: "gpt-5",
        },
        [messageRow("chat-1", "u1", null, "user", 1)],
      );

      const result = await callOkTool(createTools().readTranscript, {
        chatId: "chat-1",
      });

      expect(result.chat).toMatchObject({
        providerName: "OpenAI",
        modelId: "gpt-5",
      });
      expect(result.chat).not.toHaveProperty("agentName");
    });

    it("reports a running Chat's status and what it has persisted so far", async () => {
      seedChat({ status: "running" }, [
        messageRow("chat-1", "u1", null, "user", 1),
      ]);

      const result = await callOkTool(createTools().readTranscript, {
        chatId: "chat-1",
      });

      expect(result.chat.status).toBe("running");
      expect(result.messages.map((message) => message.role)).toEqual(["user"]);
    });

    it("walks the Active path across pages, leaving Alternatives out", async () => {
      const messages: Row[] = [];
      let parent: string | null = null;
      for (let i = 0; i < CHAT_TRANSCRIPT_PAGE_MAX_MESSAGES + 1; i++) {
        const id = `m${i}`;
        messages.push(
          messageRow(
            "chat-1",
            id,
            parent,
            i % 2 === 0 ? "user" : "assistant",
            i,
            [text(id)],
          ),
        );
        parent = id;
      }
      // An Alternative under m0 that is not on the Active path.
      messages.push(messageRow("chat-1", "alternative", "m0", "assistant", 99));
      seedChat({ activeLeafId: parent }, messages);

      const tools = createTools();
      const first = await callOkTool(tools.readTranscript, {
        chatId: "chat-1",
      });
      expect(first.messages).toHaveLength(CHAT_TRANSCRIPT_PAGE_MAX_MESSAGES);
      expect(first.nextCursor).not.toBeNull();

      const second = await callOkTool(tools.readTranscript, {
        chatId: "chat-1",
        cursor: first.nextCursor!,
      });

      const ids = [...first.messages, ...second.messages].map(
        (message) => (message.parts[0] as { text: string }).text,
      );
      expect(ids).toEqual(
        Array.from({ length: CHAT_TRANSCRIPT_PAGE_MAX_MESSAGES + 1 }, (_, i) =>
          String(`m${i}`),
        ),
      );
      expect(ids).not.toContain("alternative");
      expect(second.nextCursor).toBeNull();
    });

    it("ends a page at a message boundary when the byte budget is reached", async () => {
      const chunk = "x".repeat(Math.ceil(CHAT_TRANSCRIPT_PAGE_MAX_BYTES * 0.6));
      seedChat({}, [
        messageRow("chat-1", "first", null, "user", 1, [text(chunk)]),
        messageRow("chat-1", "second", "first", "assistant", 2, [text(chunk)]),
      ]);

      const tools = createTools();
      const first = await callOkTool(tools.readTranscript, {
        chatId: "chat-1",
      });
      expect(first.messages).toHaveLength(1);
      expect(first.nextCursor).not.toBeNull();

      const second = await callOkTool(tools.readTranscript, {
        chatId: "chat-1",
        cursor: first.nextCursor!,
      });
      expect(second.messages).toHaveLength(1);
      expect((second.messages[0].parts[0] as { text: string }).text).toBe(
        chunk,
      );
      expect(second.nextCursor).toBeNull();
    });

    it("returns a single oversized message whole, alone on its page", async () => {
      const oversized = "x".repeat(CHAT_TRANSCRIPT_PAGE_MAX_BYTES + 1);
      seedChat({}, [
        messageRow("chat-1", "large", null, "user", 1, [text(oversized)]),
      ]);

      const result = await callOkTool(createTools().readTranscript, {
        chatId: "chat-1",
      });

      expect(result.messages).toHaveLength(1);
      expect((result.messages[0].parts[0] as { text: string }).text).toBe(
        oversized,
      );
      expect(result.nextCursor).toBeNull();
    });

    it("keeps text and tool calls whole, drops reasoning, and replaces files with a placeholder", async () => {
      seedChat({}, [
        messageRow("chat-1", "u1", null, "user", 1, [
          text("Read this"),
          {
            type: "file",
            mediaType: "text/plain",
            filename: "notes.txt",
            url: `data:text/plain;base64,${Buffer.from("hello").toString("base64")}`,
          },
          {
            type: "file",
            mediaType: "image/png",
            filename: "shot.png",
            url: `data:image/png;base64,${Buffer.from("png!").toString("base64")}`,
          },
        ]),
        messageRow("chat-1", "a1", "u1", "assistant", 2, [
          { type: "reasoning", text: "thinking" },
          text("Looking"),
          {
            type: "tool-readTranscript",
            toolCallId: "call-1",
            state: "output-available",
            input: { path: "/notes.txt" },
            output: { content: "hello" },
          },
        ]),
      ]);

      const result = await callOkTool(createTools().readTranscript, {
        chatId: "chat-1",
      });

      expect(result.messages[0].parts).toEqual([
        { type: "text", text: "Read this" },
        {
          type: "file",
          name: "notes.txt",
          mediaType: "text/plain",
          size: 5,
        },
        {
          type: "file",
          name: "shot.png",
          mediaType: "image/png",
          size: 4,
        },
      ]);
      expect(JSON.stringify(result.messages[0].parts)).not.toContain("url");
      expect(result.messages[1].parts).toEqual([
        { type: "text", text: "Looking" },
        {
          type: "tool-call",
          toolName: "readTranscript",
          input: { path: "/notes.txt" },
          output: { content: "hello" },
        },
      ]);
    });

    it("sizes a stored file without reading its bytes into the result", async () => {
      mockStorageGet.mockResolvedValueOnce({
        data: Buffer.alloc(7),
        contentType: "image/png",
      });
      seedChat({}, [
        messageRow("chat-1", "u1", null, "user", 1, [
          {
            type: "file",
            mediaType: "image/png",
            filename: "shot.png",
            url: "storage://org-1/ws-1/chat-1/u1/0-aaaaaaaa.png",
          },
        ]),
      ]);

      const result = await callOkTool(createTools().readTranscript, {
        chatId: "chat-1",
      });

      expect(result.messages[0].parts).toEqual([
        {
          type: "file",
          name: "shot.png",
          mediaType: "image/png",
          size: 7,
        },
      ]);
      expect(mockStorageGet).toHaveBeenCalledWith(
        "org-1/ws-1/chat-1/u1/0-aaaaaaaa.png",
      );
    });

    it("leaves a stored file's size unknown when storage misses", async () => {
      mockStorageGet.mockResolvedValueOnce(null);
      seedChat({}, [
        messageRow("chat-1", "u1", null, "user", 1, [
          {
            type: "file",
            mediaType: "image/png",
            filename: "shot.png",
            url: "storage://org-1/ws-1/chat-1/u1/0-aaaaaaaa.png",
          },
        ]),
      ]);

      const result = await callOkTool(createTools().readTranscript, {
        chatId: "chat-1",
      });

      expect(result.messages[0].parts).toEqual([
        {
          type: "file",
          name: "shot.png",
          mediaType: "image/png",
          size: null,
        },
      ]);
    });

    it("rejects a cursor that is not its own", async () => {
      seedChat({}, [messageRow("chat-1", "u1", null, "user", 1)]);

      const result = await callTool(createTools().readTranscript, {
        chatId: "chat-1",
        cursor: "not-a-cursor",
      });

      expect(result).toEqual({
        error:
          "Invalid cursor. Call readTranscript again without a cursor to start from the beginning.",
      });
    });

    it("rejects a cursor belonging to another Chat", async () => {
      seedChat({}, [messageRow("chat-1", "u1", null, "user", 1)]);

      const otherCursor = Buffer.from(
        JSON.stringify({ chatId: "chat-2", afterId: "u1" }),
      ).toString("base64url");
      const result = await callTool(createTools().readTranscript, {
        chatId: "chat-1",
        cursor: otherCursor,
      });

      expect(result).toEqual({
        error:
          "Invalid cursor. Call readTranscript again without a cursor to start from the beginning.",
      });
    });

    it("rejects a cursor whose message has left the Active path", async () => {
      seedChat({}, [messageRow("chat-1", "u1", null, "user", 1)]);

      const staleCursor = Buffer.from(
        JSON.stringify({ chatId: "chat-1", afterId: "gone" }),
      ).toString("base64url");
      const result = await callTool(createTools().readTranscript, {
        chatId: "chat-1",
        cursor: staleCursor,
      });

      expect(result).toEqual({
        error:
          "The cursor no longer matches this Chat's Active path. Call readTranscript again without a cursor to start from the beginning.",
      });
    });
  });
});
