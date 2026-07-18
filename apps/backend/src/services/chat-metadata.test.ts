import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockDb, resetMockDb } from "../test-utils.ts";

const { mockGenerateText, mockLanguageModel } = vi.hoisted(() => ({
  mockGenerateText: vi.fn(),
  mockLanguageModel: vi.fn(),
}));

vi.mock("ai", () => ({
  generateText: mockGenerateText,
  Output: { object: vi.fn().mockReturnValue({}) },
}));

vi.mock("./provider.ts", () => ({
  openProvider: vi.fn().mockReturnValue({
    languageModel: mockLanguageModel,
  }),
}));

import { generateChatMetadata } from "./chat-metadata.ts";
import type { PlatypusUIMessage } from "../types.ts";

const userMessage: PlatypusUIMessage = {
  id: "m-1",
  role: "user",
  parts: [{ type: "text", text: "How do I center a div?" }],
};

/** Stubs the four reads generateChatMetadata makes before the model call. */
const stubReads = (opts: {
  chat: Record<string, unknown> | undefined;
  workspace?: Record<string, unknown> | undefined;
  provider?: Record<string, unknown> | undefined;
  existingTags?: string[];
}) => {
  mockDb.limit.mockResolvedValueOnce(opts.chat ? [opts.chat] : []); // chat
  if (opts.workspace !== undefined) {
    mockDb.limit.mockResolvedValueOnce(opts.workspace ? [opts.workspace] : []); // workspace
  }
  if (opts.provider !== undefined) {
    mockDb.limit.mockResolvedValueOnce(opts.provider ? [opts.provider] : []); // provider
  }
  mockDb.execute.mockResolvedValueOnce({
    rows: (opts.existingTags ?? []).map((tag) => ({ tag })),
  });
};

const provider = {
  id: "p1",
  providerType: "OpenAI",
  taskModelId: "task-model",
  modelIds: ["task-model"],
};

describe("generateChatMetadata", () => {
  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
    mockLanguageModel.mockReturnValue({});
  });

  const params = {
    chatId: "chat-1",
    workspaceId: "ws-1",
    orgId: "org-1",
    providerId: "p1",
  };

  it("titles an Untitled chat and normalizes tags", async () => {
    stubReads({
      chat: { id: "chat-1", title: "Untitled", messages: [userMessage] },
      workspace: { id: "ws-1", taskModelProviderId: null },
      provider,
    });
    mockGenerateText.mockResolvedValueOnce({
      output: { title: "Centering a div", tags: ["CSS", "layout", "css"] },
    });
    const updated = { id: "chat-1", title: "Centering a div" };
    mockDb.returning.mockResolvedValueOnce([updated]);

    const result = await generateChatMetadata(params);

    expect(result).toEqual(updated);
    const setArg = mockDb.set.mock.calls[0][0] as Record<string, unknown>;
    expect(setArg.title).toBe("Centering a div");
    // kebab-cased + deduped
    expect(setArg.tags).toEqual(["css", "layout"]);
  });

  it("truncates a title longer than 30 characters", async () => {
    stubReads({
      chat: { id: "chat-1", title: "Untitled", messages: [userMessage] },
      workspace: { id: "ws-1", taskModelProviderId: null },
      provider,
    });
    mockGenerateText.mockResolvedValueOnce({
      output: {
        title: "This is an absurdly long chat title that keeps going",
        tags: ["misc"],
      },
    });
    mockDb.returning.mockResolvedValueOnce([{ id: "chat-1" }]);

    await generateChatMetadata(params);

    const setArg = mockDb.set.mock.calls[0][0] as Record<string, unknown>;
    expect((setArg.title as string).length).toBe(30);
    expect(setArg.title).toBe("This is an absurdly long chat…");
  });

  it("prefers the workspace task-model provider override", async () => {
    stubReads({
      chat: { id: "chat-1", title: "Untitled", messages: [userMessage] },
      workspace: { id: "ws-1", taskModelProviderId: "override-provider" },
      provider: { ...provider, id: "override-provider" },
    });
    mockGenerateText.mockResolvedValueOnce({
      output: { title: "Titled", tags: ["a"] },
    });
    mockDb.returning.mockResolvedValueOnce([{ id: "chat-1" }]);

    const result = await generateChatMetadata(params);
    expect(result).not.toBeNull();
    // The provider lookup ran (workspace + provider reads consumed).
    expect(mockGenerateText).toHaveBeenCalledTimes(1);
  });

  it("skips (returns null) when the chat is already titled", async () => {
    stubReads({
      chat: { id: "chat-1", title: "My renamed chat", messages: [userMessage] },
    });

    const result = await generateChatMetadata(params);

    expect(result).toBeNull();
    expect(mockGenerateText).not.toHaveBeenCalled();
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it("skips when there is no user message with text", async () => {
    stubReads({
      chat: {
        id: "chat-1",
        title: "Untitled",
        messages: [{ id: "a", role: "assistant", parts: [] }],
      },
    });

    const result = await generateChatMetadata(params);

    expect(result).toBeNull();
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  it("returns null when the chat does not exist", async () => {
    stubReads({ chat: undefined });

    const result = await generateChatMetadata(params);
    expect(result).toBeNull();
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  it("returns null when the conditional write matches zero rows (first-wins)", async () => {
    stubReads({
      chat: { id: "chat-1", title: "Untitled", messages: [userMessage] },
      workspace: { id: "ws-1", taskModelProviderId: null },
      provider,
    });
    mockGenerateText.mockResolvedValueOnce({
      output: { title: "Titled", tags: ["a"] },
    });
    // A concurrent run already flipped the title away from "Untitled", so the
    // guarded UPDATE matches no rows.
    mockDb.returning.mockResolvedValueOnce([]);

    const result = await generateChatMetadata(params);
    expect(result).toBeNull();
  });

  it("returns null when the provider cannot be resolved", async () => {
    stubReads({
      chat: { id: "chat-1", title: "Untitled", messages: [userMessage] },
      workspace: { id: "ws-1", taskModelProviderId: null },
      provider: undefined,
    });

    const result = await generateChatMetadata(params);
    expect(result).toBeNull();
    expect(mockGenerateText).not.toHaveBeenCalled();
  });
});
