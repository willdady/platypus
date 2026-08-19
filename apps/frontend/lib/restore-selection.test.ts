import { describe, it, expect, vi, afterEach } from "vitest";
import type { Agent, Chat, Provider } from "@platypus/schemas";
import { resolveRestoredSelection } from "./restore-selection";

const provider = (over: Partial<Provider> = {}): Provider =>
  ({
    id: "p1",
    name: "Test",
    modelIds: [{ id: "gpt-4", passthroughFileTypes: [] }],
    ...over,
  }) as unknown as Provider;

const agent = (over: Partial<Agent> = {}): Agent =>
  ({
    id: "a1",
    providerId: "p1",
    modelId: "gpt-4",
    ...over,
  }) as unknown as Agent;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveRestoredSelection — priority 1 (existing chat)", () => {
  it("restores the chat's Agent when it still exists", () => {
    const result = resolveRestoredSelection({
      chatData: { agentId: "a1" } as Chat,
      storedSelection: null,
      providers: [provider()],
      agents: [agent()],
    });
    expect(result).toEqual({ agentId: "a1", modelId: "", providerId: "" });
  });

  it("falls through to provider/model when the chat's Agent was deleted", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = resolveRestoredSelection({
      chatData: {
        agentId: "deleted-agent",
        providerId: "p1",
        modelId: "gpt-4",
      } as Chat,
      storedSelection: null,
      providers: [provider()],
      // A non-empty list missing the target id — genuinely deleted, as
      // opposed to merely not having loaded yet (see the next test).
      agents: [agent({ id: "some-other-agent" })],
    });
    expect(result).toEqual({
      agentId: "",
      modelId: "gpt-4",
      providerId: "p1",
    });
  });

  it("does not judge the Agent reference before `agents` has loaded", () => {
    // agents.length === 0 here means "still loading", not "deleted" — treating
    // it as deleted would commit to Priority 3 before the Agent ever gets a
    // chance to match once the real list arrives (a regression this guards).
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = resolveRestoredSelection({
      chatData: {
        agentId: "a1",
        providerId: "p1",
        modelId: "gpt-4",
      } as Chat,
      storedSelection: null,
      providers: [provider()],
      agents: [],
    });
    expect(warn).not.toHaveBeenCalledWith(
      expect.stringContaining("no longer exists"),
    );
    expect(result).toEqual({
      agentId: "",
      modelId: "gpt-4",
      providerId: "p1",
    });
  });

  it("restores a bare model id to its aliased option (ADR-0017)", () => {
    const result = resolveRestoredSelection({
      chatData: { providerId: "p1", modelId: "gpt-4" } as Chat,
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
    expect(result).toEqual({
      agentId: "",
      modelId: "alias:flagship",
      providerId: "p1",
    });
  });

  it("falls back to the provider's first model when the persisted model is gone", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = resolveRestoredSelection({
      chatData: { providerId: "p1", modelId: "removed-model" } as Chat,
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

  it("falls back to the first available provider when the persisted Provider was removed", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fallbackProvider = provider({
      id: "p2",
      modelIds: [{ id: "claude", passthroughFileTypes: [] }],
    });
    const result = resolveRestoredSelection({
      chatData: { providerId: "removed-provider", modelId: "gpt-4" } as Chat,
      storedSelection: null,
      providers: [fallbackProvider],
      agents: [],
    });
    expect(result).toEqual({
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
    expect(result).toEqual({ agentId: "a1", modelId: "", providerId: "" });
  });

  it("restores a stored provider/model selection", () => {
    const result = resolveRestoredSelection({
      chatData: undefined,
      storedSelection: { type: "provider", providerId: "p1", modelId: "gpt-4" },
      providers: [provider()],
      agents: [],
    });
    expect(result).toEqual({
      agentId: "",
      modelId: "gpt-4",
      providerId: "p1",
    });
  });

  it("is never consulted when a chat already exists", () => {
    // A chat exists but has neither agentId nor providerId/modelId set — an
    // edge case, but localStorage still must not leak into a real chat, so
    // this should fall through to priority 3 rather than the stored value.
    const result = resolveRestoredSelection({
      chatData: {} as Chat,
      storedSelection: { type: "agent", id: "a1" },
      providers: [provider()],
      agents: [agent()],
    });
    expect(result).toEqual({
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
    expect(result).toEqual({
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
    expect(result).toEqual({
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
