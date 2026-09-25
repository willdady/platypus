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
import { logger } from "../logger.ts";
import { eq } from "drizzle-orm";
import { memoryDailySummary as memoryDailySummaryTable } from "../db/schema.ts";

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
  modelIds: [],
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

  it("marks a chat completed without a model call when nothing is new", async () => {
    const provider = makeProvider();
    setupWhere([makeWorkspace()], [provider]);
    mockDb.limit.mockResolvedValueOnce([makeChat()]);
    vi.mocked(loadActivePath).mockResolvedValueOnce({ messages: [], tree: [] });

    await processMemoryExtractionBatch();

    expect(mockGenerateText).not.toHaveBeenCalled();
    expect(mockDb.set).toHaveBeenLastCalledWith(
      expect.objectContaining({ memoryExtractionStatus: "completed" }),
    );
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
    expect(mockDb.set).toHaveBeenCalledWith({
      summary: "Updated summary",
      embedding: null,
      updatedAt: expect.any(Date) as unknown,
    });
    expect(mockDb.where).toHaveBeenCalledWith(
      eq(memoryDailySummaryTable.id, "existing-1"),
    );
  });

  it("logs how many old summaries it pruned past the workspace's cap", async () => {
    setupWhere([makeWorkspace({ maxDailySummaries: 5 })], [makeProvider()]);
    mockDb.limit.mockResolvedValueOnce([makeChat()]).mockResolvedValueOnce([]);
    mockDb.execute.mockResolvedValue({ rowCount: 2 });
    mockOpenProvider.mockReturnValue({
      languageModel: vi.fn(() => ({ id: "model" })),
    });
    mockGenerateText.mockResolvedValue({ text: "Updated summary" });

    await processMemoryExtractionBatch();

    const [statement] = mockDb.execute.mock.calls[0] as [{ values: unknown[] }];
    // Scoped to this user and Workspace, keeping the newest `maxDailySummaries`.
    expect(statement.values).toEqual(["u1", "ws-1", 5]);
    expect(logger.info).toHaveBeenCalledWith(
      "Pruned 2 old daily summaries for user u1 in workspace ws-1",
    );
  });

  it("still saves the summary, without an embedding, when embedding fails", async () => {
    const workspace = makeWorkspace({ memoryEmbeddingProviderId: "p-embed" });
    setupWhere(
      [workspace],
      [
        makeProvider(),
        makeProvider({ id: "p-embed", embeddingModelId: "embed-model" }),
      ],
    );
    mockDb.limit.mockResolvedValueOnce([makeChat()]).mockResolvedValueOnce([]);
    mockDb.execute.mockResolvedValue({ rowCount: 0 });
    mockOpenProvider.mockReturnValue({
      languageModel: vi.fn(() => ({ id: "model" })),
    });
    mockGenerateText.mockResolvedValue({ text: "Updated summary" });
    mockGenerateEmbedding.mockRejectedValue(new Error("embed down"));

    await processMemoryExtractionBatch();

    expect(mockDb.values).toHaveBeenCalledWith(
      expect.objectContaining({ summary: "Updated summary", embedding: null }),
    );
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: "chat-1" }),
      "Failed to generate embedding for daily summary: embed down",
    );
    expect(mockDb.set).toHaveBeenLastCalledWith(
      expect.objectContaining({ memoryExtractionStatus: "completed" }),
    );
  });

  it("marks the chat failed and carries on when processing it throws", async () => {
    setupWhere([makeWorkspace()], [makeProvider()]);
    mockDb.limit.mockResolvedValueOnce([makeChat()]);
    vi.mocked(loadActivePath).mockRejectedValueOnce(new Error("db hiccup"));

    await expect(processMemoryExtractionBatch()).resolves.toBeUndefined();

    expect(mockDb.set).toHaveBeenLastCalledWith(
      expect.objectContaining({ memoryExtractionStatus: "failed" }),
    );
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: "chat-1" }),
      "Error processing chat for memory extraction",
    );
  });

  it("logs and rethrows when the batch itself fails", async () => {
    const boom = new Error("db down");
    mockDb.where.mockRejectedValueOnce(boom);

    await expect(processMemoryExtractionBatch()).rejects.toBe(boom);
    expect(logger.error).toHaveBeenCalledWith(
      { error: boom },
      "Error in memory extraction batch",
    );
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
      return /chat:(\S+)/.exec(prompt)?.[1];
    });
  };

  /**
   * `exchanges` user/assistant pairs, `id:0` onwards. The first names the Chat,
   * so a prompt says whose it is.
   */
  const messagesFor = (id: string, exchanges = 1): Message[] =>
    Array.from({ length: exchanges }, (_, i): Message[] => [
      { role: "user", parts: [{ type: "text", text: `chat:${id} q${i}` }] },
      { role: "assistant", parts: [{ type: "text", text: `a${i}` }] },
    ]).flat();

  const chat = (id: string, overrides: Record<string, unknown> = {}) => ({
    id,
    messages: messagesFor(id),
    ...overrides,
  });

  /** The text between `<tag>` and `</tag>` in the prompt of model call `n`. */
  const section = (tag: string, n = 0) => {
    const { prompt } = mockGenerateText.mock.calls[n][0] as { prompt: string };
    return new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`).exec(prompt)![1];
  };

  /** `messages` with each text part padded out to `length` characters. */
  const padded = (messages: Message[], length: number): Message[] =>
    messages.map((m) => ({
      ...m,
      parts: m.parts.map((p) => ({ ...p, text: p.text.padEnd(length, "x") })),
    }));

  /** The one Provider, now declaring the extraction model's context window. */
  const declareWindow = (contextWindow: number) => {
    fake.tables.provider[0].modelIds = [
      { id: "gpt-4o-mini", passthroughFileTypes: [], contextWindow },
    ];
  };

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
      memoryCursorId: "new:1",
      lastMemoryProcessedAt: T0,
    });
  });

  it("selects a Chat whose leaf has moved past its cursor", async () => {
    seedChats(
      chat("stale", {
        messages: messagesFor("stale", 2),
        memoryExtractionStatus: "completed",
        memoryCursorId: "stale:1",
      }),
    );

    expect(await run()).toEqual(["stale"]);
  });

  it("skips a Chat whose leaf is its cursor, however recent its last turn", async () => {
    seedChats(
      chat("fresh", {
        memoryExtractionStatus: "completed",
        memoryCursorId: "fresh:1",
        lastMemoryProcessedAt: minutes(-30),
        lastTurnAt: minutes(-10),
      }),
      chat("empty", { messages: [] }),
    );

    expect(await run()).toEqual([]);
    expect(chatRow("fresh")).toMatchObject({
      memoryExtractionStatus: "completed",
      lastMemoryProcessedAt: minutes(-30),
    });
    expect(chatRow("empty").lastMemoryProcessedAt).toBeNull();
  });

  it("skips a Chat that is mid-turn", async () => {
    seedChats(
      chat("never-read", { status: "running" }),
      chat("new-turn", {
        status: "running",
        messages: messagesFor("new-turn", 2),
        memoryExtractionStatus: "completed",
        memoryCursorId: "new-turn:1",
      }),
    );

    expect(await run()).toEqual([]);
  });

  it("keeps the one-hour backoff for a failed Chat", async () => {
    seedChats(
      chat("recent-fail", {
        memoryExtractionStatus: "failed",
        lastMemoryProcessedAt: minutes(-30),
      }),
      chat("old-fail", {
        memoryExtractionStatus: "failed",
        lastMemoryProcessedAt: minutes(-61),
      }),
      chat("old-fail-caught-up", {
        memoryExtractionStatus: "failed",
        memoryCursorId: "old-fail-caught-up:1",
        lastMemoryProcessedAt: minutes(-61),
      }),
    );

    expect(await run()).toEqual(["old-fail"]);
    for (const id of ["recent-fail", "old-fail-caught-up"]) {
      expect(chatRow(id).memoryExtractionStatus).toBe("failed");
    }
    expect(chatRow("old-fail-caught-up").lastMemoryProcessedAt).toEqual(
      minutes(-61),
    );
  });

  it("leaves the cursor where it was when the pass fails", async () => {
    seedChats(
      chat("flaky", {
        messages: messagesFor("flaky", 2),
        memoryCursorId: "flaky:1",
      }),
    );
    mockGenerateText.mockRejectedValueOnce(new Error("LLM down"));

    expect(await run()).toEqual(["flaky"]);
    expect(chatRow("flaky")).toMatchObject({
      memoryExtractionStatus: "failed",
      memoryCursorId: "flaky:1",
    });

    vi.setSystemTime(minutes(61));
    expect(await run()).toEqual(["flaky"]);
    expect(section("new-messages")).toBe(
      "user: chat:flaky q1\n\nassistant: a1",
    );
  });

  it("fails a pass the model answers with nothing, leaving the cursor", async () => {
    seedChats(
      chat("mute", {
        messages: messagesFor("mute", 2),
        memoryCursorId: "mute:1",
      }),
    );
    mockGenerateText.mockResolvedValueOnce({ text: "  " });

    expect(await run()).toEqual(["mute"]);
    expect(chatRow("mute")).toMatchObject({
      memoryExtractionStatus: "failed",
      memoryCursorId: "mute:1",
    });
  });

  it("sends only a new turn as new, with what came before as context", async () => {
    seedChats(
      chat("long", {
        messages: messagesFor("long", 2),
        memoryCursorId: "long:1",
      }),
    );

    expect(await run()).toEqual(["long"]);
    expect(section("new-messages")).toBe("user: chat:long q1\n\nassistant: a1");
    expect(section("context")).toBe("user: chat:long q0\n\nassistant: a0");
    expect(chatRow("long").memoryCursorId).toBe("long:3");
  });

  it("counts a turn that lands during the pass as new on the next one", async () => {
    seedChats(chat("busy"));
    const [, , question, reply] = messagesFor("busy", 2);
    mockGenerateText.mockImplementationOnce(() => {
      // A Chat turn lands while the model is summarising the Chat.
      fake.tables.chat_message.push(
        messageRow("busy", question, 2),
        messageRow("busy", reply, 3),
      );
      chatRow("busy").activeLeafId = "busy:3";
      return Promise.resolve({ text: "Updated summary" });
    });

    expect(await run()).toEqual(["busy"]);
    expect(section("new-messages")).toBe("user: chat:busy q0\n\nassistant: a0");
    expect(chatRow("busy").memoryCursorId).toBe("busy:1");

    expect(await run()).toEqual(["busy"]);
    expect(section("new-messages")).toBe("user: chat:busy q1\n\nassistant: a1");
    expect(chatRow("busy").memoryCursorId).toBe("busy:3");
  });

  it("treats what follows the deepest shared message as new after a move to another Alternative", async () => {
    seedChats(
      chat("alt", {
        messages: messagesFor("alt", 2),
        memoryCursorId: "alt:3",
      }),
    );
    // The User edits the second question, and the reply lands under the edit.
    fake.tables.chat_message.push(
      { ...messageRow("alt", exchange[0], 4), parentId: "alt:1" },
      messageRow("alt", exchange[1], 5),
    );
    chatRow("alt").activeLeafId = "alt:5";

    expect(await run()).toEqual(["alt"]);
    expect(section("context")).toBe("user: chat:alt q0\n\nassistant: a0");
    expect(section("new-messages")).toBe("user: hi\n\nassistant: hello");
    expect(chatRow("alt").memoryCursorId).toBe("alt:5");
  });

  it("walks back from a deleted cursor to the deepest message still on the Active path", async () => {
    seedChats(
      chat("del", {
        messages: messagesFor("del", 3),
        memoryCursorId: "del:3",
      }),
    );
    fake.tables.chat_message[3].deletedAt = new Date();

    expect(await run()).toEqual(["del"]);
    expect(section("context")).toBe(
      "user: chat:del q0\n\nassistant: a0\n\nuser: chat:del q1",
    );
    expect(section("new-messages")).toBe("user: chat:del q2\n\nassistant: a2");
  });

  it("moves the cursor to the leaf without a model call when nothing is new", async () => {
    seedChats(
      chat("back", {
        messages: messagesFor("back", 2),
        memoryCursorId: "back:3",
      }),
    );
    chatRow("back").activeLeafId = "back:1";

    expect(await run()).toEqual([]);
    expect(chatRow("back")).toMatchObject({
      memoryExtractionStatus: "completed",
      memoryCursorId: "back:1",
    });
    expect(await run()).toEqual([]);
  });

  it("keeps context within a quarter of the budget, and the prompt within the budget", async () => {
    seedChats(
      chat("big", {
        messages: padded(messagesFor("big", 10), 300),
        memoryCursorId: "big:17",
      }),
    );
    // Half of 4,000 tokens is a 2,000-token budget: 8,000 characters.
    declareWindow(4_000);

    expect(await run()).toEqual(["big"]);
    const { prompt } = mockGenerateText.mock.calls[0][0] as { prompt: string };
    expect(prompt.length).toBeLessThanOrEqual(8_000);
    const context = section("context");
    expect(context.length).toBeLessThanOrEqual(2_000);
    // The most recent of what came before, as much as fits.
    expect(context.length).toBeGreaterThan(1_500);
    expect(context).toMatch(/assistant: a8x+$/);
    expect(section("new-messages")).toMatch(
      /^user: chat:big q9x+\n\nassistant: a9x+$/,
    );
  });

  it("budgets 32k tokens when the model declares no context window", async () => {
    // Two fit in 128,000 characters, three do not.
    seedChats(
      chat("wide", { messages: padded(messagesFor("wide", 2), 60_000) }),
    );

    expect(await run()).toEqual(["wide"]);
    const { prompt } = mockGenerateText.mock.calls[0][0] as { prompt: string };
    expect(prompt.length).toBeLessThanOrEqual(128_000);
    expect(chatRow("wide").memoryCursorId).toBe("wide:1");
  });

  it("extracts new messages larger than the budget over several ticks, one chunk each", async () => {
    seedChats(
      chat("chunk", { messages: padded(messagesFor("chunk", 6), 1_000) }),
    );
    declareWindow(4_000);

    const extracted: string[] = [];
    let ticks = 0;
    // Bounded, so a cursor that stops moving fails rather than hangs.
    while (ticks < 20 && (await run()).length) {
      ticks++;
      for (const line of section("new-messages").split("\n\n")) {
        extracted.push(/[qa]\d+/.exec(line)![0]);
      }
      // On the last message of the chunk.
      expect(chatRow("chunk").memoryCursorId).toBe(
        `chunk:${extracted.length - 1}`,
      );
    }

    // Each message once, in order.
    expect(ticks).toBeGreaterThan(1);
    expect(ticks).toBeLessThan(20);
    expect(extracted).toEqual(
      [0, 1, 2, 3, 4, 5].flatMap((i) => [`q${i}`, `a${i}`]),
    );
  });

  it("cuts a message larger than the whole budget, marked and logged, and moves past it", async () => {
    seedChats(
      chat("cut", {
        messages: [
          ...padded(messagesFor("cut").slice(0, 1), 20_000),
          ...messagesFor("cut").slice(1),
        ],
      }),
    );
    declareWindow(4_000);

    expect(await run()).toEqual(["cut"]);
    const { prompt } = mockGenerateText.mock.calls[0][0] as { prompt: string };
    expect(prompt.length).toBeLessThanOrEqual(8_000);
    expect(section("new-messages")).toMatch(
      /^user: chat:cut q0x+ \[truncated\]$/,
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: "cut", messageId: "cut:0" }),
      expect.stringContaining("truncated"),
    );
    expect(chatRow("cut").memoryCursorId).toBe("cut:0");

    await run();
    expect(section("new-messages")).toBe("assistant: a0");
    expect(chatRow("cut").memoryCursorId).toBe("cut:1");
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
