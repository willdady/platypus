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
    mockExistingChat.mockResolvedValue([]);
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
  });

  it("skips Memories retrieval altogether when excluded", async () => {
    await start(false);

    expect(retrieveRecentSummaries).not.toHaveBeenCalled();
    const input = runInput();
    expect(input.memorySnapshot).toBeUndefined();
    expect(input.includeMemories).toBe(false);
  });
});
