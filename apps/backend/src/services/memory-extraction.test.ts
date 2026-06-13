import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockDb, resetMockDb } from "../test-utils.ts";

const { mockGenerateText, mockOpenProvider, mockGenerateEmbedding } =
  vi.hoisted(() => ({
    mockGenerateText: vi.fn(),
    mockOpenProvider: vi.fn(),
    mockGenerateEmbedding: vi.fn(),
  }));

vi.mock("ai", () => ({ generateText: mockGenerateText }));
vi.mock("./provider.ts", () => ({ openProvider: mockOpenProvider }));
vi.mock("./embedding.ts", () => ({ generateEmbedding: mockGenerateEmbedding }));
vi.mock("../logger.ts", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock("nanoid", () => ({ nanoid: () => "generated-id" }));

import { processMemoryExtractionBatch } from "./memory-extraction.ts";

const makeWorkspace = (overrides: Record<string, unknown> = {}) => ({
  id: "ws-1",
  ownerId: "u1",
  memoryExtractionProviderId: "p-extract",
  memoryEmbeddingProviderId: null,
  maxDailySummaries: 90,
  ...overrides,
});

const makeChat = (overrides: Record<string, unknown> = {}) => ({
  id: "chat-1",
  workspaceId: "ws-1",
  memoryExtractionStatus: "pending",
  lastMemoryProcessedAt: null,
  updatedAt: new Date(),
  messages: [
    { role: "user", parts: [{ type: "text", text: "hi" }] },
    { role: "assistant", parts: [{ type: "text", text: "hello" }] },
  ],
  ...overrides,
});

const makeProvider = (overrides: Record<string, unknown> = {}) => ({
  id: "p-extract",
  providerType: "OpenAI",
  apiKey: "sk-test",
  memoryExtractionModelId: "gpt-4o-mini",
  embeddingModelId: null,
  ...overrides,
});

/**
 * Wires up `where` to return queued terminal values for queries that end in
 * `.where(...)`, while returning `mockDb` for intermediate `where` calls
 * (so `.orderBy().limit()` chains continue to resolve).
 *
 * Order of `where` calls in processMemoryExtractionBatch happy path:
 * 1. workspaces query (terminal)         → resolves
 * 2. chats query (intermediate)          → mockDb
 * 3. providers query (terminal)          → resolves
 * 4+. status update / summary update where calls (terminal, result discarded)
 */
function setupWhere(workspaces: unknown[], providers: unknown[]) {
  mockDb.where
    .mockResolvedValueOnce(workspaces) // 1. workspaces query (terminal)
    .mockReturnValueOnce(mockDb) // 2. chats query (intermediate)
    .mockResolvedValueOnce(providers) // 3. providers query (terminal)
    .mockReturnValue(mockDb); // 4+. subsequent terminal awaits — discarded
}

describe("processMemoryExtractionBatch", () => {
  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
  });

  it("returns early when no workspaces have memory extraction enabled", async () => {
    mockDb.where.mockResolvedValueOnce([]);

    await processMemoryExtractionBatch();

    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  it("returns early when there are no chats to process", async () => {
    setupWhere([makeWorkspace()], []);
    mockDb.limit.mockResolvedValueOnce([]); // chatsToProcess

    await processMemoryExtractionBatch();

    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  it("marks a chat completed when it has fewer than 2 messages", async () => {
    const provider = makeProvider();
    setupWhere([makeWorkspace()], [provider]);
    mockDb.limit.mockResolvedValueOnce([{ chat: makeChat({ messages: [] }) }]);

    await processMemoryExtractionBatch();

    expect(mockGenerateText).not.toHaveBeenCalled();
    expect(mockDb.update).toHaveBeenCalled();
  });

  it("calls the LLM and inserts a new daily summary when none exists", async () => {
    setupWhere([makeWorkspace()], [makeProvider()]);
    mockDb.limit
      .mockResolvedValueOnce([{ chat: makeChat() }]) // chatsToProcess
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
      .mockResolvedValueOnce([{ chat: makeChat() }])
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
    mockDb.limit
      .mockResolvedValueOnce([{ chat: makeChat() }])
      .mockResolvedValueOnce([]);

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
    mockDb.limit
      .mockResolvedValueOnce([{ chat: makeChat() }])
      .mockResolvedValueOnce([]);
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
