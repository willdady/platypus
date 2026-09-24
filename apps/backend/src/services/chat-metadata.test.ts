import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockDb, resetMockDb } from "../test-utils.ts";
import { logger } from "../logger.ts";

const { mockGenerateText, mockLanguageModel, mockLoadActivePath } = vi.hoisted(
  () => ({
    mockGenerateText: vi.fn(),
    mockLanguageModel: vi.fn(),
    mockLoadActivePath: vi.fn(),
  }),
);

vi.mock("./chat-messages.ts", () => ({ loadActivePath: mockLoadActivePath }));

vi.mock("ai", () => ({
  generateText: mockGenerateText,
  Output: { object: vi.fn().mockReturnValue({}) },
}));

vi.mock("./provider.ts", () => ({
  openProvider: vi.fn().mockReturnValue({
    languageModel: mockLanguageModel,
  }),
}));

import { generateChatMetadata, toKebabCase } from "./chat-metadata.ts";
import type { PlatypusUIMessage } from "../types.ts";

const userMessage: PlatypusUIMessage = {
  id: "m-1",
  role: "user",
  parts: [{ type: "text", text: "How do I center a div?" }],
};

/**
 * Stubs the reads generateChatMetadata makes before the model call. A Chat's
 * `messages` are its Active path, read from the Chat's leaf.
 */
const stubReads = (opts: {
  chat:
    (Record<string, unknown> & { messages?: PlatypusUIMessage[] }) | undefined;
  workspace?: Record<string, unknown> | undefined;
  provider?: Record<string, unknown> | undefined;
  existingTags?: string[];
}) => {
  const { messages = [], ...chat } = opts.chat ?? {};
  mockDb.limit.mockResolvedValueOnce(
    opts.chat ? [{ ...chat, activeLeafId: "leaf-1" }] : [],
  ); // chat
  mockLoadActivePath.mockResolvedValue({ messages, tree: [] });
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
  workspaceId: "ws-1",
  organizationId: null,
};

/** The same Provider as a Shared (org-scoped) row. */
const sharedProvider = {
  ...provider,
  workspaceId: null,
  organizationId: "org-1",
};

describe("toKebabCase", () => {
  it.each([
    ["Machine Learning", "machine-learning"],
    ["machineLearning", "machine-learning"],
    ["machine_learning", "machine-learning"],
    ["C++/Rust!", "crust"],
    ["already-kebab", "already-kebab"],
    ["HTTP", "http"],
  ])("normalizes %j to %j", (input, expected) => {
    expect(toKebabCase(input)).toBe(expected);
  });
});

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
    // The Active path, not the Chat's Alternatives.
    expect(mockLoadActivePath).toHaveBeenCalledWith("chat-1", "leaf-1");
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

  it("refuses a Shared provider that is not attached to this workspace", async () => {
    // Titling resolves its Provider through the Scoped-resource authority, so a
    // Shared Provider reaches this Workspace only where an Attachment does
    // (ADR-0007) — matching every other resource a Chat turn resolves.
    stubReads({
      chat: { id: "chat-1", title: "Untitled", messages: [userMessage] },
      workspace: { id: "ws-1", taskModelProviderId: null },
      provider: sharedProvider,
    });
    mockDb.limit.mockResolvedValueOnce([]); // attachment check → not attached

    const result = await generateChatMetadata(params);
    expect(result).toBeNull();
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  it("titles with a Shared provider attached to this workspace", async () => {
    stubReads({
      chat: { id: "chat-1", title: "Untitled", messages: [userMessage] },
      workspace: { id: "ws-1", taskModelProviderId: null },
      provider: sharedProvider,
    });
    mockDb.limit.mockResolvedValueOnce([{ id: "att-1" }]); // attached here
    mockGenerateText.mockResolvedValueOnce({
      output: { title: "Titled", tags: ["a"] },
    });
    mockDb.returning.mockResolvedValueOnce([{ id: "chat-1" }]);

    const result = await generateChatMetadata(params);
    expect(result).not.toBeNull();
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

  // Titling is fire-and-forget: the caller swallows the outcome, so without a
  // log an unresolvable provider is indistinguishable from "titling is broken".
  it("warns, naming the provider, when the provider cannot be resolved", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => logger);
    stubReads({
      chat: { id: "chat-1", title: "Untitled", messages: [userMessage] },
      workspace: { id: "ws-1", taskModelProviderId: "prov-override" },
      provider: undefined,
    });

    await generateChatMetadata(params);

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: "chat-1",
        workspaceId: "ws-1",
        providerId: "prov-override",
        fromTaskModelOverride: true,
      }),
      expect.stringContaining("not visible in this workspace"),
    );
    warn.mockRestore();
  });
});
