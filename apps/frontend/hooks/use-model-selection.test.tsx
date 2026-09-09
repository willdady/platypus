import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { Agent, Chat, Provider } from "@platypus/schemas";
import {
  useModelSelection,
  type ModelSelection,
  type UseModelSelectionInput,
} from "./use-model-selection";
import { encodeAgentSelection } from "@/lib/selection-reference";

const WORKSPACE_ID = "w1";
const STORAGE_KEY = `platypus:workspace:${WORKSPACE_ID}:lastSelection`;

const provider = (over: Partial<Provider> = {}): Provider =>
  ({
    id: "p1",
    name: "Test",
    modelIds: [
      { id: "gpt-4", passthroughFileTypes: [] },
      { id: "gpt-5", passthroughFileTypes: [] },
    ],
    ...over,
  }) as unknown as Provider;

const agent = (over: Partial<Agent> = {}): Agent =>
  ({
    id: "a1",
    name: "Agent One",
    providerId: "p1",
    modelId: "gpt-4",
    ...over,
  }) as unknown as Agent;

const store = (value: unknown) =>
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({ value, expiresAt: Date.now() + 60_000 }),
  );

/**
 * Renders the hook while keeping every render's result, so a test can assert
 * on what the picker WOULD have painted — the flicker in issue #799 was
 * invisible to a test that only looked at the settled value.
 */
const renderTracked = (initialProps: UseModelSelectionInput) => {
  const renders: { selection: ModelSelection; isResolved: boolean }[] = [];
  const view = renderHook(
    (props: UseModelSelectionInput) => {
      const result = useModelSelection(props);
      renders.push({
        selection: result.selection,
        isResolved: result.isResolved,
      });
      return result;
    },
    { initialProps },
  );
  /** The selections the picker would have shown as a real choice, in order. */
  const painted = () =>
    renders.filter((r) => r.isResolved).map((r) => r.selection);
  return { ...view, renders, painted };
};

const base: UseModelSelectionInput = {
  chatData: undefined,
  providers: [provider()],
  agents: [agent()],
  isChatLoading: false,
  workspaceId: WORKSPACE_ID,
};

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useModelSelection — nothing paints before the ladder resolves", () => {
  it("resolves the stored Agent on the very first render", () => {
    store({ type: "agent", id: "a1" });
    const { renders, painted } = renderTracked(base);

    expect(renders[0].isResolved).toBe(true);
    expect(painted()[0]).toEqual({
      agentId: "a1",
      modelId: "",
      providerId: "",
    });
  });

  it("reports unresolved rather than an empty selection while the chat row is in flight", () => {
    store({ type: "agent", id: "a1" });
    const { renders, painted, rerender } = renderTracked({
      ...base,
      isChatLoading: true,
    });

    expect(renders[0].isResolved).toBe(false);
    expect(renders[0].selection).toEqual({
      agentId: "",
      modelId: "",
      providerId: "",
    });
    expect(painted()).toEqual([]);

    // The row read 404s to `null` for a brand-new chat.
    rerender({ ...base, isChatLoading: false });
    expect(painted()[0]).toEqual({
      agentId: "a1",
      modelId: "",
      providerId: "",
    });
  });

  it("stays unresolved while the Agent list is in flight for a chat row naming an Agent", () => {
    store({ type: "agent", id: "a1" });
    const chatData = {
      agentId: "a2",
      providerId: "p1",
      modelId: "gpt-4",
    } as Chat;
    const { painted, rerender } = renderTracked({
      ...base,
      chatData,
      agents: undefined,
    });

    // Resolving now would name the row's provider/model and then swap to the
    // Agent once the list lands — one flicker traded for another.
    expect(painted()).toEqual([]);

    rerender({ ...base, chatData, agents: [agent({ id: "a2" })] });
    expect(painted()[0]).toEqual({
      agentId: "a2",
      modelId: "",
      providerId: "",
    });
  });

  it("paints the chat row's selection, never the stored one, for an existing chat", () => {
    store({ type: "agent", id: "a1" });
    const { painted } = renderTracked({
      ...base,
      chatData: { providerId: "p1", modelId: "gpt-5" } as Chat,
    });

    expect(painted()[0]).toEqual({
      agentId: "",
      modelId: "gpt-5",
      providerId: "p1",
    });
    expect(painted().every((s) => s.agentId === "")).toBe(true);
  });

  it("lands on the first provider's first model on the first render with empty storage", () => {
    const { renders, painted } = renderTracked(base);

    expect(renders[0].isResolved).toBe(true);
    expect(painted()[0]).toEqual({
      agentId: "",
      modelId: "gpt-4",
      providerId: "p1",
    });
  });

  it("stays unresolved when there is no provider to fall back to", () => {
    const { renders } = renderTracked({ ...base, providers: [] });
    expect(renders[0].isResolved).toBe(false);
  });
});

describe("useModelSelection — initialAgentId (?agentId=)", () => {
  it("wins over the stored selection on a new chat, from the first render", () => {
    store({ type: "agent", id: "a1" });
    const { renders, painted } = renderTracked({
      ...base,
      agents: [agent(), agent({ id: "a2", name: "Agent Two" })],
      initialAgentId: "a2",
    });

    expect(renders[0].isResolved).toBe(true);
    expect(painted()[0]).toEqual({
      agentId: "a2",
      modelId: "",
      providerId: "",
    });
    expect(painted().every((s) => s.agentId === "a2")).toBe(true);
  });

  it("loses to an existing chat row's own Agent", () => {
    const { painted } = renderTracked({
      ...base,
      chatData: { agentId: "a1" } as Chat,
      initialAgentId: "a2",
      agents: [agent(), agent({ id: "a2" })],
    });

    expect(painted()[0]).toEqual({
      agentId: "a1",
      modelId: "",
      providerId: "",
    });
  });
});

describe("useModelSelection — user choice", () => {
  it("a chosen Agent replaces the restored provider/model and persists", () => {
    const { result } = renderTracked(base);

    act(() => result.current.handleModelChange(encodeAgentSelection("a1")));

    expect(result.current.selection).toEqual({
      agentId: "a1",
      modelId: "",
      providerId: "",
    });
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).value).toEqual({
      type: "agent",
      id: "a1",
    });
  });

  it("keeps the user's choice when the chat row later names something else", () => {
    const { result, rerender } = renderTracked(base);

    act(() => result.current.handleModelChange(encodeAgentSelection("a1")));
    rerender({
      ...base,
      chatData: { providerId: "p1", modelId: "gpt-5" } as Chat,
    });

    expect(result.current.selection.agentId).toBe("a1");
  });
});

describe("useModelSelection — workspace and stale references", () => {
  it("hands a `?agentId=` naming a deleted Agent back to the ladder", () => {
    // Pinning the dead id would leave the trigger labelled "Select model" for
    // as long as the link is open, which is the state issue #799 forbids.
    const { renders, painted } = renderTracked({
      ...base,
      initialAgentId: "gone",
    });

    expect(renders[0].isResolved).toBe(true);
    expect(painted()[0]).toEqual({
      agentId: "",
      modelId: "gpt-4",
      providerId: "p1",
    });
  });

  it("re-reads storage per workspace rather than carrying a selection across", () => {
    store({ type: "agent", id: "a1" });
    const { result, rerender } = renderTracked(base);
    expect(result.current.selection.agentId).toBe("a1");

    // A workspace switch that reuses this mount: the other workspace has its
    // own key, and nothing is stored under it.
    rerender({ ...base, workspaceId: "w2" });

    expect(result.current.selection).toEqual({
      agentId: "",
      modelId: "gpt-4",
      providerId: "p1",
    });
  });

  it("does not refresh the stored selection's expiry on a bare revalidation", () => {
    const { rerender } = renderTracked(base);
    const written = localStorage.getItem(STORAGE_KEY);

    // SWR handing back an equal-but-new array is not a selection change.
    rerender({ ...base, providers: [provider()], agents: [agent()] });

    expect(localStorage.getItem(STORAGE_KEY)).toBe(written);
  });
});
