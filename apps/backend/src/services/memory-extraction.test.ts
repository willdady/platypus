import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockDb, resetMockDb } from "../test-utils.ts";

// Mock ai module
const mockGenerateText = vi.fn();
vi.mock("ai", () => ({
  generateText: (...args: any[]) => mockGenerateText(...args),
  Output: { object: vi.fn(({ schema }: any) => schema) },
}));

// Mock nanoid
vi.mock("nanoid", () => ({
  nanoid: vi.fn(() => "test-id-123"),
}));

// Mock memory-retrieval
const mockRetrieveUserLevel = vi.fn();
const mockRetrieveWorkspaceLevel = vi.fn();
const mockFormatMemoriesForPrompt = vi.fn();
vi.mock("./memory-retrieval.ts", () => ({
  retrieveUserLevelMemories: (...args: any[]) => mockRetrieveUserLevel(...args),
  retrieveWorkspaceLevelMemories: (...args: any[]) =>
    mockRetrieveWorkspaceLevel(...args),
  formatMemoriesForPrompt: (...args: any[]) =>
    mockFormatMemoriesForPrompt(...args),
}));

// Mock chat-execution
vi.mock("./chat-execution.ts", () => ({
  createModel: vi.fn(() => [{}, "mock-model"]),
}));

import { processMemoryExtractionBatch } from "./memory-extraction.ts";

const makeWorkspace = (overrides: Partial<any> = {}) => ({
  id: "ws-1",
  ownerId: "user-1",
  memoryExtractionProviderId: "provider-1",
  ...overrides,
});

const makeProvider = (overrides: Partial<any> = {}) => ({
  id: "provider-1",
  memoryExtractionModelId: "gpt-4",
  providerType: "OpenAI",
  ...overrides,
});

const makeChat = (overrides: Partial<any> = {}) => ({
  id: "chat-1",
  workspaceId: "ws-1",
  messages: [
    { role: "user", parts: [{ type: "text", text: "Hello" }] },
    { role: "assistant", parts: [{ type: "text", text: "Hi there" }] },
  ],
  memoryExtractionStatus: "pending",
  ...overrides,
});

/**
 * Sets up standard mocks for findChatsToProcess with the given chats.
 * Handles the complex chain of DB calls inside findChatsToProcess.
 */
const setupFindChatsToProcess = (
  chats: any[],
  workspaces = [makeWorkspace()],
  providers = [makeProvider()],
) => {
  // 1. workspacesWithExtraction: db.select().from().where() → returns array
  mockDb.where.mockResolvedValueOnce(workspaces);

  if (workspaces.length === 0) return;

  // 2. chatsToProcess: db.select().from().where().orderBy().limit() → returns array
  mockDb.where.mockReturnValueOnce(mockDb); // where returns mockDb for chaining
  mockDb.orderBy.mockReturnValueOnce(mockDb); // orderBy returns mockDb for chaining
  mockDb.limit.mockResolvedValueOnce(chats.map((chat) => ({ chat }))); // limit resolves

  // 3. providers: db.select().from().where() → returns array (always fetched)
  mockDb.where.mockResolvedValueOnce(providers);
};

describe("processMemoryExtractionBatch", () => {
  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
    // Default: where returns mockDb for chaining (used by updateChatExtractionStatus etc.)
    mockDb.where.mockReturnValue(mockDb);
    mockDb.orderBy.mockReturnValue(mockDb);
    mockRetrieveUserLevel.mockResolvedValue([]);
    mockRetrieveWorkspaceLevel.mockResolvedValue([]);
    mockFormatMemoriesForPrompt.mockReturnValue("No existing memories.");
  });

  it("returns early when no workspaces have extraction enabled", async () => {
    setupFindChatsToProcess([], []);

    await processMemoryExtractionBatch();

    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  it("returns early when no chats need processing", async () => {
    setupFindChatsToProcess([]);

    await processMemoryExtractionBatch();

    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  it("skips chats with fewer than 2 messages and marks completed", async () => {
    const chat = makeChat({
      messages: [{ role: "user", parts: [{ type: "text", text: "Hello" }] }],
    });

    setupFindChatsToProcess([chat]);

    await processMemoryExtractionBatch();

    expect(mockGenerateText).not.toHaveBeenCalled();
    // updateChatExtractionStatus was called (set for "processing" and "completed")
    expect(mockDb.set).toHaveBeenCalled();
  });

  it("processes new memories from LLM output", async () => {
    const chat = makeChat();
    setupFindChatsToProcess([chat]);

    mockGenerateText.mockResolvedValueOnce({
      output: {
        new: [
          {
            entityType: "preference",
            entityName: "theme",
            observation: "Likes dark mode",
            scope: "user",
          },
        ],
        updates: [],
        deletes: [],
      },
    });

    await processMemoryExtractionBatch();

    expect(mockGenerateText).toHaveBeenCalledTimes(1);
    expect(mockDb.values).toHaveBeenCalled();
  });

  it("processes memory updates and verifies ownership", async () => {
    const chat = makeChat();
    setupFindChatsToProcess([chat]);

    mockGenerateText.mockResolvedValueOnce({
      output: {
        new: [],
        updates: [{ id: "mem-1", observation: "Updated preference" }],
        deletes: [],
      },
    });

    // Ownership verification for update: memory exists
    mockDb.limit.mockResolvedValueOnce([{ id: "mem-1", userId: "user-1" }]);

    await processMemoryExtractionBatch();

    expect(mockGenerateText).toHaveBeenCalledTimes(1);
    expect(mockDb.set).toHaveBeenCalled();
  });

  it("processes memory deletes and verifies ownership", async () => {
    const chat = makeChat();
    setupFindChatsToProcess([chat]);

    mockGenerateText.mockResolvedValueOnce({
      output: {
        new: [],
        updates: [],
        deletes: ["mem-1"],
      },
    });

    // Ownership verification for delete: memory exists
    mockDb.limit.mockResolvedValueOnce([{ id: "mem-1", userId: "user-1" }]);

    await processMemoryExtractionBatch();

    expect(mockGenerateText).toHaveBeenCalledTimes(1);
    expect(mockDb.delete).toHaveBeenCalled();
  });

  it("handles LLM call failure gracefully and marks chat as failed", async () => {
    const chat = makeChat();
    setupFindChatsToProcess([chat]);

    mockGenerateText.mockRejectedValueOnce(new Error("LLM error"));

    // Should not throw - errors are caught and chat is marked as failed
    await processMemoryExtractionBatch();

    expect(mockDb.set).toHaveBeenCalled();
  });
});
