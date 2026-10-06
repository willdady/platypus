import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockStream, mockExistingChat } = vi.hoisted(() => ({
  mockStream: vi.fn(),
  mockExistingChat: vi.fn(),
}));

vi.mock("../index.ts", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({ limit: mockExistingChat })),
      })),
    })),
  },
}));
vi.mock("../runs/agent-runner.ts", () => ({
  agentRunner: { stream: mockStream },
}));
vi.mock("./chat-messages.ts", () => ({
  resolveTurn: vi.fn(() =>
    Promise.resolve({
      messages: [{ id: "m1", role: "user", parts: [] }],
      message: { id: "m1", role: "user", parts: [] },
      parentId: null,
    }),
  ),
}));
vi.mock("./slash-command.ts", () => ({
  seedUserInvokedSkill: vi.fn(({ messages }: { messages: unknown[] }) =>
    Promise.resolve(messages),
  ),
}));
vi.mock("./memory-retrieval.ts", () => ({
  resolveMemoryPin: vi.fn(() => ({ reuse: false })),
  retrieveRecentSummaries: vi.fn(() => Promise.resolve([])),
  formatSummariesForSystemPrompt: vi.fn(() => "fresh-block"),
}));

import { startChatTurn } from "./chat-turn.ts";
import { retrieveRecentSummaries } from "./memory-retrieval.ts";
import type { WorkspaceScope } from "../scope.ts";
import type { RunInput } from "../runs/types.ts";

const runInput = () =>
  (mockStream.mock.calls[0][0] as { input: RunInput }).input;

const scope: WorkspaceScope = {
  principal: { kind: "user", userId: "u1", name: "U" },
  orgId: "o1",
  workspaceId: "w1",
  isWorkspaceOwner: true,
};

const start = (includeMemories: boolean) =>
  startChatTurn({
    scope,
    request: {
      id: "chat-1",
      workspaceId: "w1",
      message: { id: "m1", role: "user", parts: [] },
      parentId: null,
    },
    includeMemories,
    origin: "http://x",
  });

describe("startChatTurn", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset, not cleared: a lookup a test queued and never reached goes too.
    mockExistingChat.mockReset().mockResolvedValue([]);
    mockStream.mockResolvedValue(new Response("ok"));
  });

  it("retrieves and pins Memories when included", async () => {
    await start(true);

    expect(retrieveRecentSummaries).toHaveBeenCalledWith(
      "u1",
      "w1",
      expect.any(Date),
    );
    const input = runInput();
    expect(input.memorySnapshot).toBe("fresh-block");
    expect(input.includeMemories).toBe(true);
    expect(input.memoryTools).toBe(true);
  });

  it("skips Memories retrieval altogether when excluded", async () => {
    await start(false);

    expect(retrieveRecentSummaries).not.toHaveBeenCalled();
    const input = runInput();
    expect(input.memorySnapshot).toBeUndefined();
    expect(input.includeMemories).toBe(false);
    expect(input.memoryTools).toBe(false);
  });

  it("serves the Memory tools with Memories in a Chat started in the UI", async () => {
    mockExistingChat.mockResolvedValueOnce([
      { a2aEndpointId: null, a2aClientName: null },
    ]);

    await start(true);

    expect(runInput()).toMatchObject({
      includeMemories: true,
      memoryTools: true,
    });
  });

  // Issue #1294: an A2A Chat follows its endpoint's Include Memories on every
  // turn, the Owner's own from the UI included.
  describe("in an A2A Chat", () => {
    const a2aChat = { a2aEndpointId: "ep-1", a2aClientName: "Hermes" };

    it("leaves Memories and the Memory tools out when the endpoint does", async () => {
      mockExistingChat
        .mockResolvedValueOnce([a2aChat])
        .mockResolvedValueOnce([{ includeMemories: false }]);

      await start(true);

      expect(retrieveRecentSummaries).not.toHaveBeenCalled();
      expect(runInput()).toMatchObject({
        memorySnapshot: undefined,
        includeMemories: false,
        memoryTools: false,
      });
    });

    it("includes them when the endpoint does", async () => {
      mockExistingChat
        .mockResolvedValueOnce([a2aChat])
        .mockResolvedValueOnce([{ includeMemories: true }]);

      await start(true);

      expect(runInput()).toMatchObject({
        memorySnapshot: "fresh-block",
        includeMemories: true,
        memoryTools: true,
      });
    });

    it.each([
      ["whose endpoint was deleted", a2aChat],
      ["known only by its client label", { ...a2aChat, a2aEndpointId: null }],
    ])("leaves them out of a Chat %s", async (_case, chat) => {
      mockExistingChat.mockResolvedValueOnce([chat]).mockResolvedValueOnce([]);

      await start(true);

      expect(retrieveRecentSummaries).not.toHaveBeenCalled();
      expect(runInput()).toMatchObject({
        includeMemories: false,
        memoryTools: false,
      });
    });
  });
});
