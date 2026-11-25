import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ChatStatus } from "ai";
import type { PlatypusUIMessage } from "@platypus/schemas";
import {
  alternativesRow,
  alternativesTree,
  chatMessage as message,
} from "@/test/chat-test-fixtures";
import { resetSharedSpies, toastError } from "@/test/test-utils";
import { CHAT_POLL_INTERVAL_MS } from "@/lib/chat-recovery";
import { optionalFetcher } from "@/lib/utils";
import { useChatTranscript } from "./use-chat-transcript";

const CHAT_ID = "chat-1";
const CHAT_URL = `http://test/organizations/org1/workspaces/ws1/chat/${CHAT_ID}`;

type ReadCall = {
  entity: string;
  scope: unknown;
  config: Record<string, unknown> | undefined;
};

const { read, writeAtMock } = vi.hoisted(() => {
  const read: {
    calls: ReadCall[];
    data: unknown;
    isLoading: boolean;
    mutate: ReturnType<typeof vi.fn>;
  } = { calls: [], data: undefined, isLoading: false, mutate: vi.fn() };
  return { read, writeAtMock: vi.fn() };
});

vi.mock("@/hooks/use-scoped-swr", () => ({
  useScopedSWR: (
    entity: string,
    scope: unknown,
    config?: Record<string, unknown>,
  ) => {
    read.calls.push({ entity, scope, config });
    return { data: read.data, isLoading: read.isLoading, mutate: read.mutate };
  },
}));

vi.mock("@/lib/api-write", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api-write")>()),
  writeAt: writeAtMock,
}));

function setup(
  initial: {
    messages?: PlatypusUIMessage[];
    status?: ChatStatus;
    error?: Error | undefined;
  } = {},
) {
  const state = {
    messages: initial.messages ?? [],
    status: initial.status ?? "ready",
    error: initial.error,
  };
  const setMessages = vi.fn(
    (
      update:
        | PlatypusUIMessage[]
        | ((held: PlatypusUIMessage[]) => PlatypusUIMessage[]),
    ) => {
      state.messages =
        typeof update === "function" ? update(state.messages) : update;
    },
  );

  const props = () => ({
    messages: state.messages,
    status: state.status,
    error: state.error,
  });

  const rendered = renderHook(
    (current: ReturnType<typeof props>) =>
      useChatTranscript({
        scope: { orgId: "org1", workspaceId: "ws1" },
        chatId: CHAT_ID,
        chatUrl: CHAT_URL,
        messages: current.messages,
        setMessages,
        status: current.status,
        error: current.error,
      }),
    { initialProps: props() },
  );

  const rerender = () => rendered.rerender(props());

  return {
    state,
    setMessages,
    result: rendered.result,
    rerender,
    readLands(data: unknown) {
      read.data = data;
      rerender();
    },
    setStatus(next: ChatStatus, nextError?: Error) {
      state.status = next;
      state.error = nextError;
      rerender();
    },
    through(...statuses: ChatStatus[]) {
      for (const next of statuses) {
        this.setStatus(next, next === "error" ? DROPPED_ERROR : undefined);
      }
    },
  };
}

type Harness = ReturnType<typeof setup>;

const DROPPED_ERROR = new Error("Failed to fetch");
const DROPPED: ChatStatus[] = ["submitted", "streaming", "error"];
const REFUSED: ChatStatus[] = ["submitted", "error"];

function applied(h: Harness, held: PlatypusUIMessage[]) {
  const update = h.setMessages.mock.calls.at(-1)?.[0] as
    ((held: PlatypusUIMessage[]) => PlatypusUIMessage[]) | undefined;
  expect(typeof update).toBe("function");
  return update!(held);
}

function chatRead() {
  const call = read.calls.at(-1);
  if (!call) throw new Error("the Chat read was never made");
  return call;
}

function pollFor(row: { status: string } | null) {
  const refreshInterval = chatRead().config?.refreshInterval as (
    data: unknown,
  ) => number;
  return refreshInterval(row);
}

beforeEach(() => {
  resetSharedSpies();
  read.calls = [];
  read.data = undefined;
  read.isLoading = false;
  read.mutate.mockReset();
  read.mutate.mockResolvedValue(undefined);
  writeAtMock.mockReset();
  writeAtMock.mockResolvedValue({
    outcome: "success",
    data: {},
    revalidateKeys: [],
  });
});

describe("the Chat detail read", () => {
  it("reads the scoped row through the fetcher that treats a missing row as absence", () => {
    setup();

    expect(chatRead().entity).toBe(`chat/${CHAT_ID}`);
    expect(chatRead().scope).toEqual({ orgId: "org1", workspaceId: "ws1" });
    expect(chatRead().config?.fetcher).toBe(optionalFetcher);
  });

  it("leaves focus and reconnect revalidation on", () => {
    setup();

    const { config } = chatRead();
    expect(config?.revalidateOnFocus).toBeUndefined();
    expect(config?.revalidateOnReconnect).toBeUndefined();
  });
});

describe("polling a live run", () => {
  it.each([
    ["submitted", { status: "succeeded" }],
    ["streaming", { status: "succeeded" }],
    ["streaming", { status: "running" }],
    ["submitted", null],
  ] as const)(
    "does not poll while this tab's turn is %s (row %j)",
    (turnStatus, row) => {
      setup({ status: turnStatus });

      expect(pollFor(row)).toBe(0);
    },
  );

  it("resumes polling from the read taken when a stream drops", () => {
    read.data = { status: "succeeded", messages: [] };
    const h = setup();
    h.through(...DROPPED);

    expect(read.mutate).toHaveBeenCalledWith();
    expect(pollFor({ status: "succeeded" })).toBe(0);
    expect(pollFor({ status: "running" })).toBe(CHAT_POLL_INTERVAL_MS);
  });

  it("polls a run this tab did not start", () => {
    setup();

    expect(pollFor({ status: "running" })).toBe(CHAT_POLL_INTERVAL_MS);
  });

  it("keeps polling after a stream drops while the run is still going", () => {
    read.data = { status: "running", messages: [] };
    const h = setup();
    h.through(...DROPPED);

    expect(pollFor({ status: "running" })).toBe(CHAT_POLL_INTERVAL_MS);
  });

  it("does not poll a turn the server refused", () => {
    const h = setup();
    h.through(...REFUSED);

    expect(pollFor(null)).toBe(0);
  });

  it("does not poll an idle Chat", () => {
    setup();

    expect(pollFor({ status: "succeeded" })).toBe(0);
  });
});

describe("applying a fetched snapshot", () => {
  it("hydrates an empty transcript from the row", () => {
    const snapshot = [message("u1", "q"), message("a1", "an answer")];
    read.data = { status: "succeeded", messages: snapshot };
    const h = setup();

    expect(applied(h, [])).toBe(snapshot);
  });

  it("refuses a snapshot behind what is on screen", () => {
    read.data = {
      status: "running",
      messages: [message("u1", "q"), message("a1", "the first third")],
    };
    const h = setup();
    h.through(...DROPPED);

    const held = [
      message("u1", "q"),
      message("a1", "the first third and then some more of it"),
    ];
    expect(applied(h, held)).toBe(held);
  });

  it("applies a snapshot that has moved on", () => {
    const snapshot = [
      message("u1", "q"),
      message("a1", "the first third and then the rest of the answer"),
    ];
    read.data = { status: "running", messages: snapshot };
    const h = setup();
    h.through(...DROPPED);

    expect(applied(h, [message("u1", "q"), message("a1", "the first")])).toBe(
      snapshot,
    );
  });

  it("applies an emptied Chat", () => {
    read.data = { status: "succeeded", messages: [] };
    const h = setup();

    expect(applied(h, [message("u1", "q")])).toEqual([]);
  });

  it("does not touch the transcript while this tab is streaming", () => {
    read.data = { status: "running", messages: [message("u1", "q")] };
    const h = setup({ status: "streaming" });

    expect(h.setMessages).not.toHaveBeenCalled();
  });
});

describe("writing to the server-owned Transcript", () => {
  it("deletes on the server, then reads the row back", async () => {
    const h = setup({ messages: [message("u1", "q"), message("a1", "a")] });

    h.result.current.deleteMessage("u1");

    await waitFor(() => expect(read.mutate).toHaveBeenCalled());
    expect(writeAtMock).toHaveBeenCalledWith(`${CHAT_URL}/messages/u1`, {
      method: "DELETE",
    });
    expect(h.setMessages).not.toHaveBeenCalled();
  });

  it("reports a refused delete and does not re-read", async () => {
    writeAtMock.mockResolvedValue({
      outcome: "conflict",
      message: "A reply is still being written in this Chat",
    });
    const h = setup({ messages: [message("u1", "q")] });

    h.result.current.deleteMessage("u1");

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        "A reply is still being written in this Chat",
      ),
    );
    expect(read.mutate).not.toHaveBeenCalled();
  });

  it("posts a /compact with its instruction, and sends no message", async () => {
    const h = setup();

    await h.result.current.compact("keep the decisions");

    expect(writeAtMock).toHaveBeenCalledWith(`${CHAT_URL}/compact`, {
      method: "POST",
      data: { instruction: "keep the decisions" },
    });
    expect(h.setMessages).not.toHaveBeenCalled();
  });
});

describe("routing a chat error", () => {
  it("recovers a dropped connection to a run that is still going", () => {
    read.data = { status: "running", messages: [] };
    const h = setup();
    h.through(...DROPPED);

    expect(h.result.current.errorTreatment).toBe("recovering");
  });

  it("says nothing once the run has finished behind the drop", () => {
    read.data = { status: "succeeded", messages: [] };
    const h = setup();
    h.through(...DROPPED);

    expect(h.result.current.errorTreatment).toBe("none");
  });

  it("fails a run that reached a terminal failed status", () => {
    read.data = { status: "failed", messages: [] };
    const h = setup();
    h.through(...DROPPED);

    expect(h.result.current.errorTreatment).toBe("failure");
  });

  it("fails a request that never established", () => {
    read.data = { status: "succeeded", messages: [] };
    const h = setup();
    h.through(...REFUSED);

    expect(h.result.current.errorTreatment).toBe("failure");
  });

  it("says nothing at all while a turn is healthy", () => {
    const h = setup();

    expect(h.result.current.errorTreatment).toBe("none");
  });
});

describe("turn establishment", () => {
  it("judges a second turn on its own stream, not an earlier turn's", () => {
    read.data = { status: "succeeded", messages: [] };
    const h = setup();
    h.through("submitted", "streaming", "ready", "submitted", "error");

    expect(h.result.current.errorTreatment).toBe("failure");
  });

  it("keeps the answer while a broken turn sits there", () => {
    read.data = { status: "running", messages: [] };
    const h = setup();
    h.through("submitted", "streaming", "error", "error");

    expect(h.result.current.errorTreatment).toBe("recovering");
  });
});

describe("the run belief", () => {
  it("holds the composer for a dropped stream mid-run", () => {
    read.data = { status: "running", messages: [] };
    const h = setup();
    h.through(...DROPPED);

    expect(h.result.current.runHeldElsewhere).toBe(true);
    expect(h.result.current.effectiveStatus).toBe("streaming");
  });

  it("holds the composer for a tab that arrived mid-run", () => {
    read.data = { status: "running", messages: [] };
    const h = setup();

    expect(h.result.current.runHeldElsewhere).toBe(true);
  });

  it("releases it once the run is over, with no failure on the button", () => {
    read.data = { status: "succeeded", messages: [] };
    const h = setup();
    h.through(...DROPPED);

    expect(h.result.current.runHeldElsewhere).toBe(false);
    expect(h.result.current.effectiveStatus).toBe("ready");
  });

  it("keeps the error reading for a turn that actually failed", () => {
    read.data = { status: "failed", messages: [] };
    const h = setup();
    h.through(...DROPPED);

    expect(h.result.current.effectiveStatus).toBe("error");
  });
});

describe("switching between Alternatives", () => {
  const SWITCH_URL = `${CHAT_URL}/active-leaf`;

  const path = (...ids: string[]) => ids.map((id) => message(id, id));
  const original = path("u1", "a1", "u2", "a2", "u3", "a3");
  const edited = path("u1", "a1", "u2b", "a2b");
  const row = (messages: PlatypusUIMessage[]) =>
    alternativesRow(messages, CHAT_ID);

  const onScreen = (h: Harness) => h.state.messages.map((m) => m.id);

  function showing(held: PlatypusUIMessage[]) {
    read.data = row(held);
    return setup({ messages: held });
  }

  function deferredWrite() {
    const answers: ((outcome: unknown) => void)[] = [];
    writeAtMock.mockImplementation(
      () => new Promise((resolve) => answers.push(resolve)),
    );
    return {
      answer(outcome: unknown) {
        const next = answers.shift();
        if (!next) throw new Error("no write was in flight");
        next(outcome);
      },
    };
  }

  it("hands each message its position among its Alternatives", () => {
    const h = showing(edited);

    expect(h.result.current.positions.get("u2b")).toEqual({
      index: 1,
      count: 3,
      previousId: "u2",
      nextId: "u2c",
    });
    expect(h.result.current.positions.get("a2b")).toBeUndefined();
  });

  it.each([
    ["a longer path", edited, "u2b", "u2", original],
    ["a shorter path", original, "u2", "u2b", edited],
  ])(
    "switches to %s and is not dragged back by a poll while the switch is pending",
    async (_, from, fromId, targetId, to) => {
      const writes = deferredWrite();
      const h = showing(from);

      act(() => {
        void h.result.current.switchAlternative(fromId, targetId);
      });

      expect(onScreen(h)).toEqual(["u1", "a1", targetId]);
      expect(writeAtMock).toHaveBeenCalledWith(
        SWITCH_URL,
        expect.objectContaining({
          method: "PUT",
          data: { messageId: targetId },
        }),
      );

      h.readLands(row(from));
      expect(onScreen(h)).toEqual(["u1", "a1", targetId]);

      writes.answer({
        outcome: "success",
        data: { messages: to, tree: alternativesTree },
        revalidateKeys: [],
      });
      await waitFor(() => expect(onScreen(h)).toEqual(to.map((m) => m.id)));
      const [update, options] = read.mutate.mock.calls.at(-1)! as [
        (current: unknown) => unknown,
        { revalidate: boolean },
      ];
      expect(options).toEqual({ revalidate: false });
      expect(update(row(from))).toEqual(row(to));

      h.readLands(row(edited));
      expect(onScreen(h)).toEqual(edited.map((m) => m.id));
    },
  );

  it("leaves a turn started while the switch was pending alone", async () => {
    const writes = deferredWrite();
    const h = showing(edited);

    act(() => {
      void h.result.current.switchAlternative("u2b", "u2");
    });
    h.setStatus("streaming");
    writes.answer({
      outcome: "success",
      data: { messages: original, tree: alternativesTree },
      revalidateKeys: [],
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(onScreen(h)).toEqual(["u1", "a1", "u2"]);
    expect(read.mutate).not.toHaveBeenCalled();
  });

  it("reverts and says so when the switch is refused", async () => {
    writeAtMock.mockResolvedValue({
      outcome: "conflict",
      message: "A reply is still being written in this Chat",
    });
    const h = showing(edited);

    act(() => {
      void h.result.current.switchAlternative("u2b", "u2");
    });

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        "A reply is still being written in this Chat",
      ),
    );
    expect(h.state.messages).toBe(edited);
    expect(read.mutate).not.toHaveBeenCalled();
  });

  it("sends a later switch only once the earlier one has answered, and ends on the later", async () => {
    const writes = deferredWrite();
    const h = showing(original);

    act(() => {
      void h.result.current.switchAlternative("u2", "u2b");
    });
    h.rerender();
    act(() => {
      void h.result.current.switchAlternative("u2b", "u2c");
    });

    expect(writeAtMock).toHaveBeenCalledTimes(1);
    expect(onScreen(h)).toEqual(["u1", "a1", "u2c"]);

    writes.answer({
      outcome: "success",
      data: { messages: edited, tree: alternativesTree },
      revalidateKeys: [],
    });
    await waitFor(() => expect(writeAtMock).toHaveBeenCalledTimes(2));
    expect(writeAtMock).toHaveBeenLastCalledWith(
      SWITCH_URL,
      expect.objectContaining({ data: { messageId: "u2c" } }),
    );
    expect(onScreen(h)).toEqual(["u1", "a1", "u2c"]);

    const last = path("u1", "a1", "u2c");
    writes.answer({
      outcome: "success",
      data: { messages: last, tree: alternativesTree },
      revalidateKeys: [],
    });
    await waitFor(() => expect(read.mutate).toHaveBeenCalled());

    expect(onScreen(h)).toEqual(["u1", "a1", "u2c"]);
    expect(toastError).not.toHaveBeenCalled();
  });

  it("sends only the last of the clicks made while a switch was in flight", async () => {
    const writes = deferredWrite();
    const h = showing(original);

    act(() => {
      void h.result.current.switchAlternative("u2", "u2b");
    });
    h.rerender();
    act(() => {
      void h.result.current.switchAlternative("u2b", "u2c");
    });
    h.rerender();
    act(() => {
      void h.result.current.switchAlternative("u2c", "u2b");
    });

    writes.answer({
      outcome: "success",
      data: { messages: edited, tree: alternativesTree },
      revalidateKeys: [],
    });
    await waitFor(() => expect(writeAtMock).toHaveBeenCalledTimes(2));
    expect(writeAtMock).toHaveBeenLastCalledWith(
      SWITCH_URL,
      expect.objectContaining({ data: { messageId: "u2b" } }),
    );
  });

  it("reverts a run of switches to where the first one started", async () => {
    const writes = deferredWrite();
    const h = showing(original);

    act(() => {
      void h.result.current.switchAlternative("u2", "u2b");
    });
    h.rerender();
    act(() => {
      void h.result.current.switchAlternative("u2b", "u2c");
    });
    writes.answer({ outcome: "error", message: "Request failed" });
    await waitFor(() => expect(writeAtMock).toHaveBeenCalledTimes(2));
    writes.answer({ outcome: "error", message: "Request failed" });

    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
    expect(h.state.messages).toBe(original);
  });
});

describe("regenerate and the loading gap", () => {
  function shown(messages: PlatypusUIMessage[]) {
    read.data = alternativesRow(messages, CHAT_ID);
    return setup({ messages });
  }

  it("offers Regenerate only from the reply's own parent in the tree", () => {
    const h = shown([message("u1", "q"), message("a1", "a")]);
    expect(h.result.current.parentOf.get("a2b")).toBe("u2b");
    expect(h.result.current.isRegenerable(1)).toBe(true);

    const wrongParent = shown([message("u1", "q"), message("a2b", "a")]);
    expect(wrongParent.result.current.isRegenerable(1)).toBe(false);

    const notInTree = shown([message("u1", "q"), message("a9", "a")]);
    expect(notInTree.result.current.isRegenerable(1)).toBe(true);

    const noReplyToAnswer = shown([message("u1", "q"), message("u2", "q")]);
    expect(noReplyToAnswer.result.current.isRegenerable(1)).toBe(false);
  });

  it("starts pending only until the first messages reach the screen", () => {
    read.isLoading = true;
    const loading = setup();
    expect(loading.result.current.isTranscriptPending).toBe(true);

    read.isLoading = false;
    const arrived = shown([message("u1", "q")]);
    expect(arrived.result.current.isTranscriptPending).toBe(false);

    arrived.readLands(alternativesRow([], CHAT_ID));
    arrived.rerender();
    expect(arrived.result.current.isTranscriptPending).toBe(false);
  });
});

describe("transcript stability", () => {
  it("keeps the transcript callbacks stable across renders", () => {
    const h = setup({ messages: [message("u1", "q"), message("a1", "a")] });
    const first = {
      deleteMessage: h.result.current.deleteMessage,
      switchAlternative: h.result.current.switchAlternative,
    };

    h.rerender();

    expect(h.result.current.deleteMessage).toBe(first.deleteMessage);
    expect(h.result.current.switchAlternative).toBe(first.switchAlternative);
  });

  it("keeps the positions map stable while a reply streams", () => {
    read.data = {
      status: "running",
      messages: [],
      tree: [
        { id: "u1", parentId: null },
        { id: "u2", parentId: null },
        { id: "a1", parentId: "u1" },
      ],
    };
    const h = setup({
      messages: [message("u1", "q"), message("a1", "an answer")],
    });
    const first = h.result.current.positions;

    h.state.messages = [
      message("u1", "q"),
      message("a1", "an answer, still streaming"),
    ];
    h.rerender();

    expect(h.result.current.positions).toBe(first);
  });
});
