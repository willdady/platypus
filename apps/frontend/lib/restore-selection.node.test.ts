import { describe, it, expect, vi } from "vitest";
import type { Agent, Chat, Provider } from "@platypus/schemas";
import { resolveRestoredSelection } from "./restore-selection";
import type { Serialized } from "./api-write";

const provider = (
  over: Partial<Serialized<Provider>> = {},
): Serialized<Provider> =>
  ({
    id: "p1",
    name: "Test",
    modelIds: [{ id: "gpt-4", passthroughFileTypes: [] }],
    ...over,
  }) as unknown as Serialized<Provider>;

const agent = (over: Partial<Serialized<Agent>> = {}): Serialized<Agent> =>
  ({
    id: "a1",
    providerId: "p1",
    modelId: "gpt-4",
    ...over,
  }) as unknown as Serialized<Agent>;

describe("resolveRestoredSelection — priority 1 (existing chat)", () => {
  it("restores the chat's Agent when it still exists", () => {
    const result = resolveRestoredSelection({
      chatData: { agentId: "a1" } as Serialized<Chat>,
      storedSelection: null,
      providers: [provider()],
      agents: [agent()],
    });
    expect(result).toMatchObject({
      agentId: "a1",
      modelId: "",
      providerId: "",
    });
  });

  it("falls through to provider/model when the chat's Agent was deleted", () => {
    const result = resolveRestoredSelection({
      chatData: {
        agentId: "deleted-agent",
        providerId: "p1",
        modelId: "gpt-4",
      } as Serialized<Chat>,
      storedSelection: null,
      providers: [provider()],
      // A non-empty list missing the target id — genuinely deleted, as
      // opposed to merely not having loaded yet (see the next test).
      agents: [agent({ id: "some-other-agent" })],
    });
    expect(result).toMatchObject({
      agentId: "",
      modelId: "gpt-4",
      providerId: "p1",
    });
  });

  it("does not judge the Agent reference before `agents` has loaded", () => {
    // agents.length === 0 here means "still loading", not "deleted" — treating
    // it as deleted would commit to Priority 3 before the Agent ever gets a
    // chance to match once the real list arrives (a regression this guards).
    const result = resolveRestoredSelection({
      chatData: {
        agentId: "a1",
        providerId: "p1",
        modelId: "gpt-4",
      } as Serialized<Chat>,
      storedSelection: null,
      providers: [provider()],
      agents: [],
    });
    expect(result).toEqual({
      agentId: "",
      modelId: "gpt-4",
      providerId: "p1",
    });
  });

  it("restores a bare model id to its aliased option (ADR-0017)", () => {
    const result = resolveRestoredSelection({
      chatData: { providerId: "p1", modelId: "gpt-4" } as Serialized<Chat>,
      storedSelection: null,
      providers: [
        provider({
          modelIds: [
            { id: "gpt-4", alias: "flagship", passthroughFileTypes: [] },
          ],
        }),
      ],
      agents: [],
    });
    expect(result).toMatchObject({
      agentId: "",
      modelId: "alias:flagship",
      providerId: "p1",
    });
  });

  it("falls back to the provider's first model when the persisted model is gone", () => {
    const result = resolveRestoredSelection({
      chatData: {
        providerId: "p1",
        modelId: "removed-model",
      } as Serialized<Chat>,
      storedSelection: null,
      providers: [provider()],
      agents: [],
    });
    expect(result).toMatchObject({
      agentId: "",
      modelId: "gpt-4",
      providerId: "p1",
    });
  });

  it("falls back to the first available provider when the persisted Provider was removed", () => {
    const fallbackProvider = provider({
      id: "p2",
      modelIds: [{ id: "claude", passthroughFileTypes: [] }],
    });
    const result = resolveRestoredSelection({
      chatData: {
        providerId: "removed-provider",
        modelId: "gpt-4",
      } as Serialized<Chat>,
      storedSelection: null,
      providers: [fallbackProvider],
      agents: [],
    });
    expect(result).toMatchObject({
      agentId: "",
      modelId: "claude",
      providerId: "p2",
    });
  });
});

describe("resolveRestoredSelection — priority 2 (localStorage, new chats only)", () => {
  it("restores a stored Agent selection", () => {
    const result = resolveRestoredSelection({
      chatData: undefined,
      storedSelection: { type: "agent", id: "a1" },
      providers: [provider()],
      agents: [agent()],
    });
    expect(result).toMatchObject({
      agentId: "a1",
      modelId: "",
      providerId: "",
    });
  });

  it("restores a stored provider/model selection", () => {
    const result = resolveRestoredSelection({
      chatData: undefined,
      storedSelection: { type: "provider", providerId: "p1", modelId: "gpt-4" },
      providers: [provider()],
      agents: [],
    });
    expect(result).toMatchObject({
      agentId: "",
      modelId: "gpt-4",
      providerId: "p1",
    });
  });

  it.each([
    ["an Agent that was deleted", { type: "agent", id: "gone" }],
    [
      "a model its Provider no longer offers",
      { type: "provider", providerId: "p1", modelId: "removed-model" },
    ],
    [
      "a Provider that was removed",
      { type: "provider", providerId: "gone", modelId: "gpt-4" },
    ],
  ] as const)(
    "falls through to priority 3 when the stored value names %s",
    (_name, storedSelection) => {
      const result = resolveRestoredSelection({
        chatData: undefined,
        storedSelection,
        providers: [provider()],
        agents: [agent()],
      });
      expect(result).toMatchObject({
        agentId: "",
        modelId: "gpt-4",
        providerId: "p1",
      });
    },
  );

  it("is never consulted when a chat already exists", () => {
    // A chat exists but has neither agentId nor providerId/modelId set — an
    // edge case, but localStorage still must not leak into a real chat, so
    // this should fall through to priority 3 rather than the stored value.
    const result = resolveRestoredSelection({
      chatData: {} as Serialized<Chat>,
      storedSelection: { type: "agent", id: "a1" },
      providers: [provider()],
      agents: [agent()],
    });
    expect(result).toMatchObject({
      agentId: "",
      modelId: "gpt-4",
      providerId: "p1",
    });
  });

  it("falls through to priority 3 when the stored value names an empty/absent selection", () => {
    const result = resolveRestoredSelection({
      chatData: undefined,
      storedSelection: null,
      providers: [provider()],
      agents: [],
    });
    expect(result).toMatchObject({
      agentId: "",
      modelId: "gpt-4",
      providerId: "p1",
    });
  });
});

describe("resolveRestoredSelection — priority 3 (fallback)", () => {
  it("falls back to the first provider's first model for a brand-new chat with empty storage", () => {
    const result = resolveRestoredSelection({
      chatData: undefined,
      storedSelection: null,
      providers: [provider(), provider({ id: "p2" })],
      agents: [],
    });
    expect(result).toMatchObject({
      agentId: "",
      modelId: "gpt-4",
      providerId: "p1",
    });
  });

  it("returns null when there are no providers to fall back to", () => {
    const result = resolveRestoredSelection({
      chatData: undefined,
      storedSelection: null,
      providers: [],
      agents: [],
    });
    expect(result).toBeNull();
  });
});

describe("resolveRestoredSelection — reporting a substitution", () => {
  it("reports nothing when the chat's own selection is restored", () => {
    const result = resolveRestoredSelection({
      chatData: { providerId: "p1", modelId: "gpt-4" } as Serialized<Chat>,
      storedSelection: null,
      providers: [provider()],
      agents: [],
    });
    expect(result?.substitution).toBeUndefined();
  });

  it.each([
    [
      "the chat's Agent was deleted",
      { agentId: "gone" },
      { missing: "agent", source: "chat" },
    ],
    [
      "the chat's Provider was removed",
      { providerId: "gone", modelId: "gpt-4" },
      { missing: "provider", source: "chat" },
    ],
    [
      "the chat's model is no longer offered",
      { providerId: "p1", modelId: "removed-model" },
      { missing: "model", source: "chat" },
    ],
  ] as const)("says so when %s", (_name, chatData, expected) => {
    const result = resolveRestoredSelection({
      chatData: chatData as Serialized<Chat>,
      storedSelection: null,
      providers: [provider()],
      agents: [agent({ id: "other" })],
    });
    expect(result?.substitution).toEqual(expected);
  });

  it.each([
    ["Agent", { type: "agent", id: "gone" }, "agent"],
    [
      "Provider",
      { type: "provider", providerId: "gone", modelId: "gpt-4" },
      "provider",
    ],
    [
      "model",
      { type: "provider", providerId: "p1", modelId: "removed-model" },
      "model",
    ],
  ] as const)(
    "says so when the last-used %s is gone",
    (_name, storedSelection, missing) => {
      const result = resolveRestoredSelection({
        chatData: undefined,
        storedSelection,
        providers: [provider()],
        agents: [agent()],
      });
      expect(result?.substitution).toEqual({ missing, source: "lastUsed" });
    },
  );

  it("reports nothing for a brand-new chat with nothing remembered", () => {
    const result = resolveRestoredSelection({
      chatData: undefined,
      storedSelection: null,
      providers: [provider()],
      agents: [],
    });
    expect(result?.substitution).toBeUndefined();
  });

  it("does not log to the console", () => {
    const warn = vi.spyOn(console, "warn");
    resolveRestoredSelection({
      chatData: { providerId: "gone", modelId: "gpt-4" } as Serialized<Chat>,
      storedSelection: null,
      providers: [provider()],
      agents: [],
    });
    expect(warn).not.toHaveBeenCalled();
  });
});
