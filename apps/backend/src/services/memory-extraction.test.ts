import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mockDb, resetMockDb, seedDb, type FakeDb } from "../test-utils.ts";

const { mockGenerateText, mockOpenProvider, mockGenerateEmbedding } =
  vi.hoisted(() => ({
    mockGenerateText: vi.fn(),
    mockOpenProvider: vi.fn(),
    mockGenerateEmbedding: vi.fn(),
  }));

vi.mock("ai", () => ({ generateText: mockGenerateText }));
vi.mock("./provider.ts", () => ({ openProvider: mockOpenProvider }));
vi.mock("./embedding.ts", () => ({ generateEmbedding: mockGenerateEmbedding }));
// The real path read wherever rows are seeded; the chainable-mock tests below
// stub it, since the mock cannot answer its queries by position.
vi.mock("./chat-messages.ts", async (importActual) => {
  const actual = await importActual<typeof import("./chat-messages.ts")>();
  return { ...actual, loadActivePath: vi.fn(actual.loadActivePath) };
});

import { processMemoryExtractionBatch } from "./memory-extraction.ts";
import { loadActivePath } from "./chat-messages.ts";

const makeWorkspace = (overrides: Record<string, unknown> = {}) => ({
  id: "ws-1",
  organizationId: "org-1",
  ownerId: "u1",
  memoryExtractionProviderId: "p-extract",
  memoryEmbeddingProviderId: null,
  maxDailySummaries: 90,
  ...overrides,
});

type Message = { role: string; parts: { type: string; text: string }[] };

const exchange: Message[] = [
  { role: "user", parts: [{ type: "text", text: "hi" }] },
  { role: "assistant", parts: [{ type: "text", text: "hello" }] },
];

const makeChat = (overrides: Record<string, unknown> = {}) => ({
  id: "chat-1",
  workspaceId: "ws-1",
  memoryExtractionStatus: "pending",
  lastMemoryProcessedAt: null,
  updatedAt: new Date(),
  messages: exchange,
  ...overrides,
});

/** One `chat_message` row of a chain, `chatId:index` → `chatId:index-1`. */
const messageRow = (chatId: string, message: Message, index: number) => ({
  chatId,
  id: `${chatId}:${index}`,
  parentId: index > 0 ? `${chatId}:${index - 1}` : null,
  role: message.role,
  parts: message.parts,
  metadata: null,
  deletedAt: null,
  createdAt: new Date(index),
});

/**
 * Seeds rows as `seedDb` does, storing each Chat's `messages` the way the
 * server does: as a chain of `chat_message` rows whose last is the leaf.
 */
const seedWithMessages = (store: Record<string, Record<string, unknown>[]>) =>
  seedDb({
    ...store,
    chat: (store.chat ?? []).map(({ messages, ...chat }) => ({
      ...chat,
      activeLeafId: (messages as Message[]).length
        ? `${chat.id as string}:${(messages as Message[]).length - 1}`
        : null,
    })),
    chat_message: (store.chat ?? []).flatMap((chat) =>
      (chat.messages as Message[]).map((message, index) =>
        messageRow(chat.id as string, message, index),
      ),
    ),
  });

const makeProvider = (overrides: Record<string, unknown> = {}) => ({
  id: "p-extract",
  organizationId: null,
  workspaceId: "ws-1",
  providerType: "OpenAI",
  apiKey: "sk-test",
  memoryExtractionModelId: "gpt-4o-mini",
  embeddingModelId: null,
  ...overrides,
});

/**
 * Wires up the chainable mock for the reads processMemoryExtractionBatch makes
 * before its first Chat is processed:
 * 1. workspaces query — terminal `where`
 * 2. each workspace's Provider lookups (extraction, then embedding if set) —
 *    `where().limit(1)`, so the rows are queued on `limit`
 * 3. chats query — `where().orderBy().limit()`, queued on `limit` by the test
 *
 * Queue `providers` in lookup order; the test's own `limit` values follow.
 */
function setupWhere(workspaces: unknown[], providers: unknown[]) {
  mockDb.where
    .mockResolvedValueOnce(workspaces) // 1. workspaces query (terminal)
    .mockReturnValue(mockDb); // 2+. chained or discarded
  for (const provider of providers)
    mockDb.limit.mockResolvedValueOnce([provider]);
}

describe("processMemoryExtractionBatch", () => {
  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
    vi.mocked(loadActivePath).mockResolvedValue({
      messages: exchange as never,
      tree: [],
    });
  });

  afterEach(() => {
    vi.mocked(loadActivePath).mockReset();
  });

  it("returns early when no workspaces have memory extraction enabled", async () => {
    mockDb.where.mockResolvedValueOnce([]);

    await processMemoryExtractionBatch();

    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  it("returns early when there are no chats to process", async () => {
    setupWhere([makeWorkspace()], [makeProvider()]);
    mockDb.limit.mockResolvedValueOnce([]); // chatsToProcess

    await processMemoryExtractionBatch();

    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  it("marks a chat completed when it has fewer than 2 messages", async () => {
    const provider = makeProvider();
    setupWhere([makeWorkspace()], [provider]);
    mockDb.limit.mockResolvedValueOnce([makeChat()]);
    vi.mocked(loadActivePath).mockResolvedValueOnce({ messages: [], tree: [] });

    await processMemoryExtractionBatch();

    expect(mockGenerateText).not.toHaveBeenCalled();
    expect(mockDb.update).toHaveBeenCalled();
  });

  it("calls the LLM and inserts a new daily summary when none exists", async () => {
    setupWhere([makeWorkspace()], [makeProvider()]);
    mockDb.limit
      .mockResolvedValueOnce([makeChat()]) // chatsToProcess
      .mockResolvedValueOnce([]); // existing summary lookup → none
    mockDb.execute.mockResolvedValue({ rowCount: 0 });

    mockOpenProvider.mockReturnValue({
      languageModel: vi.fn(() => ({ id: "model" })),
    });
    mockGenerateText.mockResolvedValue({ text: "Updated summary" });

    await processMemoryExtractionBatch();

    expect(mockGenerateText).toHaveBeenCalledTimes(1);
    expect(mockDb.insert).toHaveBeenCalled();
    expect(mockDb.values).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "u1",
        workspaceId: "ws-1",
        summary: "Updated summary",
        embedding: null,
      }),
    );
  });

  it("updates an existing summary instead of inserting", async () => {
    setupWhere([makeWorkspace()], [makeProvider()]);
    mockDb.limit
      .mockResolvedValueOnce([makeChat()])
      .mockResolvedValueOnce([{ id: "existing-1", summary: "Old summary" }]);
    mockDb.execute.mockResolvedValue({ rowCount: 0 });

    mockOpenProvider.mockReturnValue({
      languageModel: vi.fn(() => ({ id: "model" })),
    });
    mockGenerateText.mockResolvedValue({ text: "Updated summary" });

    await processMemoryExtractionBatch();

    expect(mockDb.insert).not.toHaveBeenCalled();
    expect(mockDb.update).toHaveBeenCalled();
  });

  it("marks the chat as failed when the LLM call throws", async () => {
    setupWhere([makeWorkspace()], [makeProvider()]);
    mockDb.limit.mockResolvedValueOnce([makeChat()]).mockResolvedValueOnce([]);

    mockOpenProvider.mockReturnValue({
      languageModel: vi.fn(() => ({ id: "model" })),
    });
    mockGenerateText.mockRejectedValue(new Error("LLM down"));

    await processMemoryExtractionBatch();

    expect(mockDb.insert).not.toHaveBeenCalled();
    expect(mockDb.set).toHaveBeenCalledWith(
      expect.objectContaining({ memoryExtractionStatus: "failed" }),
    );
  });

  it("generates an embedding when an embedding provider is configured", async () => {
    const workspace = makeWorkspace({ memoryEmbeddingProviderId: "p-embed" });
    const extractionProvider = makeProvider();
    const embeddingProvider = makeProvider({
      id: "p-embed",
      embeddingModelId: "text-embedding-3-small",
    });

    setupWhere([workspace], [extractionProvider, embeddingProvider]);
    mockDb.limit.mockResolvedValueOnce([makeChat()]).mockResolvedValueOnce([]);
    mockDb.execute.mockResolvedValue({ rowCount: 0 });

    mockOpenProvider.mockReturnValue({
      languageModel: vi.fn(() => ({ id: "model" })),
    });
    mockGenerateText.mockResolvedValue({ text: "Updated summary" });
    mockGenerateEmbedding.mockResolvedValue([0.1, 0.2, 0.3]);

    await processMemoryExtractionBatch();

    expect(mockGenerateEmbedding).toHaveBeenCalledWith(
      expect.objectContaining({ id: "p-embed" }),
      "text-embedding-3-small",
      "Updated summary",
    );
    expect(mockDb.values).toHaveBeenCalledWith(
      expect.objectContaining({ embedding: [0.1, 0.2, 0.3] }),
    );
  });
});

/**
 * Which Chats a run picks up, evaluated against seeded rows: the chainable mock
 * above cannot see the `WHERE`, and the selection rule is all `WHERE`.
 */
describe("processMemoryExtractionBatch chat selection", () => {
  const T0 = new Date("2026-09-01T12:00:00.000Z");
  const minutes = (n: number) => new Date(T0.getTime() + n * 60 * 1000);

  let fake: FakeDb;

  const seedChats = (...chats: Record<string, unknown>[]) => {
    fake = seedWithMessages({
      workspace: [makeWorkspace()],
      provider: [makeProvider()],
      chat: chats.map((c) =>
        makeChat({ status: "succeeded", lastTurnAt: null, ...c }),
      ),
    });
  };

  const chatRow = (id: string) => fake.tables.chat.find((c) => c.id === id)!;

  /** The Chat ids whose messages reached the model on this run. */
  const run = async () => {
    mockGenerateText.mockClear();
    await processMemoryExtractionBatch();
    return mockGenerateText.mock.calls.map(([options]) => {
      const { prompt } = options as { prompt: string };
      return /chat:(\S+)/.exec(prompt)![1];
    });
  };

  /** Two messages whose text names the Chat, so a prompt says whose it is. */
  const messagesFor = (id: string): Message[] => [
    { role: "user", parts: [{ type: "text", text: `chat:${id}` }] },
    { role: "assistant", parts: [{ type: "text", text: "ok" }] },
  ];

  const chat = (id: string, overrides: Record<string, unknown> = {}) => ({
    id,
    messages: messagesFor(id),
    ...overrides,
  });

  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    mockOpenProvider.mockReturnValue({
      languageModel: vi.fn(() => ({ id: "model" })),
    });
    mockGenerateText.mockResolvedValue({ text: "Updated summary" });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("selects a Chat that has never been read", async () => {
    seedChats(chat("new"));

    expect(await run()).toEqual(["new"]);
    expect(chatRow("new")).toMatchObject({
      memoryExtractionStatus: "completed",
      lastMemoryProcessedAt: T0,
    });
  });

  it("selects a completed Chat with a turn after it was last read", async () => {
    seedChats(
      chat("stale", {
        memoryExtractionStatus: "completed",
        lastMemoryProcessedAt: minutes(-30),
        lastTurnAt: minutes(-10),
      }),
    );

    expect(await run()).toEqual(["stale"]);
  });

  it("skips a completed Chat with no turn since it was last read", async () => {
    seedChats(
      chat("fresh", {
        memoryExtractionStatus: "completed",
        lastMemoryProcessedAt: minutes(-10),
        lastTurnAt: minutes(-30),
      }),
      chat("legacy", {
        memoryExtractionStatus: "completed",
        lastMemoryProcessedAt: minutes(-10),
        lastTurnAt: null,
      }),
    );

    expect(await run()).toEqual([]);
  });

  it("skips a Chat that is mid-turn", async () => {
    seedChats(
      chat("never-read", { status: "running" }),
      chat("new-turn", {
        status: "running",
        memoryExtractionStatus: "completed",
        lastMemoryProcessedAt: minutes(-30),
        lastTurnAt: minutes(-1),
      }),
    );

    expect(await run()).toEqual([]);
  });

  it("keeps the one-hour backoff for a failed Chat", async () => {
    seedChats(
      chat("recent-fail", {
        memoryExtractionStatus: "failed",
        lastMemoryProcessedAt: minutes(-30),
        lastTurnAt: minutes(-40),
      }),
      chat("old-fail", {
        memoryExtractionStatus: "failed",
        lastMemoryProcessedAt: minutes(-61),
        lastTurnAt: minutes(-70),
      }),
    );

    expect(await run()).toEqual(["old-fail"]);
  });

  it("selects a failed Chat inside the backoff once it has a new turn", async () => {
    seedChats(
      chat("failed-then-turn", {
        memoryExtractionStatus: "failed",
        lastMemoryProcessedAt: minutes(-30),
        lastTurnAt: minutes(-10),
      }),
    );

    expect(await run()).toEqual(["failed-then-turn"]);
  });

  it("records the read time, so a turn during the pass is picked up later", async () => {
    seedChats(chat("busy"));
    mockGenerateText.mockImplementationOnce(() => {
      // A Chat turn starts while the model is summarising the Chat.
      vi.setSystemTime(minutes(2));
      Object.assign(chatRow("busy"), { lastTurnAt: new Date() });
      vi.setSystemTime(minutes(3));
      return Promise.resolve({ text: "Updated summary" });
    });

    expect(await run()).toEqual(["busy"]);
    expect(chatRow("busy").lastMemoryProcessedAt).toEqual(T0);

    vi.setSystemTime(minutes(10));
    expect(await run()).toEqual(["busy"]);
  });

  it("reads the Active path only, leaving Alternatives and deleted messages out", async () => {
    seedChats(chat("tree"));
    fake.tables.chat_message.push(
      // An edit of the first message the User has moved away from.
      {
        ...messageRow("tree", exchange[0], 9),
        parentId: null,
        parts: [{ type: "text", text: "the edited-away question" }],
      },
    );
    fake.tables.chat_message[0].parts = [
      { type: "text", text: "chat:tree" },
      { type: "text", text: " kept" },
    ];
    fake.tables.chat_message.push({
      ...messageRow("tree", exchange[0], 2),
      parentId: "tree:1",
      parts: [{ type: "text", text: "the deleted question" }],
      deletedAt: new Date(),
    });

    expect(await run()).toEqual(["tree"]);
    const { prompt } = mockGenerateText.mock.calls[0][0] as { prompt: string };
    expect(prompt).toContain("chat:tree kept");
    expect(prompt).not.toContain("edited-away");
    expect(prompt).not.toContain("deleted question");
  });

  it("re-reads a Chat that was too short when first scanned after its next turn", async () => {
    seedChats(chat("short", { messages: messagesFor("short").slice(0, 1) }));

    expect(await run()).toEqual([]);
    expect(chatRow("short").memoryExtractionStatus).toBe("completed");

    vi.setSystemTime(minutes(5));
    fake.tables.chat_message.push(
      messageRow("short", messagesFor("short")[1], 1),
    );
    Object.assign(chatRow("short"), {
      lastTurnAt: new Date(),
      activeLeafId: "short:1",
    });
    vi.setSystemTime(minutes(10));

    expect(await run()).toEqual(["short"]);
  });
});

/**
 * Which Provider a run may use, against seeded rows: a Shared Provider serves a
 * Workspace's memory only while an Attachment makes it visible there.
 */
describe("processMemoryExtractionBatch provider visibility", () => {
  const shared = (overrides: Record<string, unknown> = {}) =>
    makeProvider({ organizationId: "org-1", workspaceId: null, ...overrides });

  const attached = (resourceId: string) => ({
    id: `att-${resourceId}`,
    workspaceId: "ws-1",
    resourceType: "provider",
    resourceId,
  });

  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
    mockOpenProvider.mockReturnValue({
      languageModel: vi.fn(() => ({ id: "model" })),
    });
    mockGenerateText.mockResolvedValue({ text: "Updated summary" });
    mockGenerateEmbedding.mockResolvedValue([0.1]);
  });

  it("extracts with a Shared Provider attached to the Workspace", async () => {
    seedWithMessages({
      workspace: [makeWorkspace()],
      provider: [shared()],
      attachment: [attached("p-extract")],
      chat: [makeChat()],
    });

    await processMemoryExtractionBatch();

    expect(mockGenerateText).toHaveBeenCalledTimes(1);
  });

  it("skips a Workspace whose Shared extraction Provider is detached", async () => {
    const fake = seedWithMessages({
      workspace: [makeWorkspace()],
      provider: [shared()],
      chat: [makeChat()],
    });

    await processMemoryExtractionBatch();

    expect(mockOpenProvider).not.toHaveBeenCalled();
    expect(mockGenerateText).not.toHaveBeenCalled();
    expect(fake.tables.chat[0].memoryExtractionStatus).toBe("pending");
  });

  it("extracts without embeddings when the Shared embedding Provider is detached", async () => {
    seedWithMessages({
      workspace: [makeWorkspace({ memoryEmbeddingProviderId: "p-embed" })],
      provider: [
        makeProvider(),
        shared({ id: "p-embed", embeddingModelId: "text-embedding-3-small" }),
      ],
      chat: [makeChat()],
    });

    await processMemoryExtractionBatch();

    expect(mockGenerateText).toHaveBeenCalledTimes(1);
    expect(mockGenerateEmbedding).not.toHaveBeenCalled();
  });
});
