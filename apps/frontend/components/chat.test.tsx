import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { ChatStatus, FileUIPart } from "ai";
import type { PlatypusUIMessage } from "@platypus/backend/src/types";

/**
 * The wiring between `Chat` and `lib/chat-recovery` (issue #648).
 *
 * The recovery decisions are pure functions with their own tests; what those
 * cannot see is whether the component actually feeds them the right inputs. The
 * original bug was exactly a wiring bug — the poll interval was derived from the
 * fetched row's status and nothing else — so a test that only exercises the
 * predicates would have passed against the broken code.
 *
 * So this file asserts the seams: what the Chat detail read is configured with,
 * what reaches the interval predicate, how a fetched snapshot is applied, and
 * which of the two error surfaces a given state selects. The presentational tree
 * is stubbed down to the props under test — this is not a rendering test.
 */

type SwrCall = {
  key: string;
  fetcher: unknown;
  config: Record<string, unknown> | undefined;
};

const { harness } = vi.hoisted(() => ({
  harness: {
    swrCalls: [] as SwrCall[],
    /** Response bodies by key suffix. */
    data: new Map<string, unknown>(),
    /** Built once per key so the identity a hydrate effect keys off is stable. */
    responses: new Map<string, unknown>(),
    turn: {
      status: "ready" as ChatStatus,
      error: undefined as Error | undefined,
      messages: [] as PlatypusUIMessage[],
    },
    setMessages: vi.fn(),
    sendMessage: vi.fn(),
    chatMutate: vi.fn(),
  },
}));

vi.mock("swr", () => ({
  __esModule: true,
  default: (
    key: string | null,
    fetcher: unknown,
    config: Record<string, unknown> | undefined,
  ) => {
    if (!key) return { data: undefined, isLoading: false, mutate: vi.fn() };
    harness.swrCalls.push({ key, fetcher, config });
    let response = harness.responses.get(key);
    if (!response) {
      const match = [...harness.data.entries()].find(([suffix]) =>
        key.endsWith(suffix),
      );
      response = {
        data: match ? match[1] : undefined,
        isLoading: false,
        mutate: key.includes("/chat/") ? harness.chatMutate : vi.fn(),
      };
      harness.responses.set(key, response);
    }
    return response;
  },
  useSWRConfig: () => ({ mutate: vi.fn() }),
}));

vi.mock("@ai-sdk/react", () => ({
  useChat: () => ({
    messages: harness.turn.messages,
    setMessages: harness.setMessages,
    sendMessage: harness.sendMessage,
    status: harness.turn.status,
    error: harness.turn.error,
    regenerate: vi.fn(),
    stop: vi.fn(),
  }),
}));

vi.mock("@/app/client-context", () => ({ useBackendUrl: () => "http://test" }));
vi.mock("@/components/auth-provider", () => ({
  useAuth: () => ({ user: { id: "u1" }, ownsWorkspace: true }),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), info: vi.fn() } }));

// The presentational tree, stubbed to the props under test. `PromptInputTextarea`
// and `PromptInputSubmit` keep theirs, because the composer guard is one of the
// behaviours being pinned.
vi.mock("@/components/ai-elements/conversation", () => ({
  Conversation: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
  ConversationContent: ({ children }: { children?: React.ReactNode }) => (
    <div data-conversation>{children}</div>
  ),
  ConversationScrollButton: () => null,
}));

vi.mock("@/components/ai-elements/prompt-input", () => ({
  PromptInput: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
  PromptInputBody: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
  PromptInputFooter: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
  PromptInputTools: () => null,
  PromptInputAttachments: () => null,
  PromptInputAttachment: () => null,
  PromptInputActionMenu: () => null,
  PromptInputActionMenuTrigger: () => null,
  PromptInputActionMenuContent: () => null,
  PromptInputActionAddAttachments: () => null,
  PromptInputButton: () => null,
  PromptInputSpeechButton: () => null,
  PromptInputTextarea: ({
    placeholder,
    disabled,
    status,
  }: {
    placeholder?: string;
    disabled?: boolean;
    status?: string;
  }) => (
    <textarea
      readOnly
      placeholder={placeholder}
      disabled={disabled}
      data-status={status}
    />
  ),
  PromptInputSubmit: ({ status }: { status?: string }) => (
    <button type="submit" data-testid="submit" data-status={status} />
  ),
}));

// Stubbed to the edit seam: an Edit button per message, and whatever edit
// surface the Chat hands down for the one being edited. The transcript itself
// is `chat-message`'s own test's business.
vi.mock("./chat-message", () => ({
  ChatMessage: ({
    message,
    editor,
    onEditStart,
  }: {
    message: PlatypusUIMessage;
    editor?: React.ReactNode;
    onEditStart: (messageId: string) => void;
  }) => (
    <div>
      {editor ?? (
        <button type="button" onClick={() => onEditStart(message.id)}>
          Edit {message.id}
        </button>
      )}
    </div>
  ),
}));

// Stubbed to what the Chat hands the edit surface, and to the one thing the
// surface hands back: the whole message, attachments included.
vi.mock("./message-editor", () => ({
  MessageEditor: ({
    initialText,
    initialAttachments,
    onSubmit,
  }: {
    initialText: string;
    initialAttachments: FileUIPart[];
    onSubmit: (message: { text: string; files: FileUIPart[] }) => void;
  }) => (
    <div data-testid="editor" data-text={initialText}>
      {initialAttachments.map((file) => (
        <span key={file.url}>{file.filename}</span>
      ))}
      <button
        type="button"
        onClick={() =>
          onSubmit({
            text: `${initialText} (edited)`,
            files: initialAttachments,
          })
        }
      >
        Save
      </button>
    </div>
  ),
}));
vi.mock("./context-meter", () => ({ ContextMeter: () => null }));
vi.mock("./file-compatibility-warning", () => ({
  FileCompatibilityWarning: () => null,
}));
vi.mock("./no-providers-empty-state", () => ({
  NoProvidersEmptyState: () => null,
}));
vi.mock("./model-selector-dialog", () => ({ ModelSelectorDialog: () => null }));
vi.mock("./agent-info-dialog", () => ({ AgentInfoDialog: () => null }));
vi.mock("./chat-settings-dialog", () => ({
  ChatSettingsDialog: () => null,
  CHAT_MAX_STEPS_ERROR: "bad max steps",
}));
vi.mock("./error-dialog", () => ({
  ErrorDialog: ({ isOpen }: { isOpen: boolean }) =>
    isOpen ? <div role="dialog">Chat Error</div> : null,
}));

import { Chat } from "./chat";
import { optionalFetcher } from "@/lib/utils";
import { CHAT_POLL_INTERVAL_MS } from "@/lib/chat-recovery";

const CHAT_ID = "chat-1";
const CHAT_KEY = `http://test/organizations/org1/workspaces/ws1/chat/${CHAT_ID}`;

const provider = {
  id: "p1",
  name: "OpenRouter",
  modelIds: [{ id: "m1", passthroughFileTypes: [] }],
};

const message = (id: string, text: string): PlatypusUIMessage =>
  ({
    id,
    role: id.startsWith("u") ? "user" : "assistant",
    parts: [{ type: "text", text }],
  }) as PlatypusUIMessage;

/** The config the Chat detail read was last built with. */
const chatReadConfig = () => {
  const call = harness.swrCalls.filter((c) => c.key === CHAT_KEY).at(-1);
  if (!call) throw new Error("the Chat detail read was never made");
  return call;
};

/** What the interval predicate answers for a given fetched row. */
const pollFor = (row: { status: string } | null) => {
  const refreshInterval = chatReadConfig().config?.refreshInterval as (
    data: unknown,
  ) => number;
  return refreshInterval(row);
};

const renderChat = () =>
  render(<Chat orgId="org1" workspaceId="ws1" chatId={CHAT_ID} />);

/**
 * Renders, then walks the local turn through a status sequence the way the chat
 * hook would. The sequence matters: whether a turn ever reached `streaming` is
 * what tells a dropped connection from a request the server refused, so a test
 * that jumped straight to `error` would be describing a different failure.
 */
const renderThrough = (...statuses: ChatStatus[]) => {
  const view = renderChat();
  for (const status of statuses) {
    harness.turn.status = status;
    if (status === "error") harness.turn.error = new Error("Failed to fetch");
    view.rerender(<Chat orgId="org1" workspaceId="ws1" chatId={CHAT_ID} />);
  }
  return view;
};

/** A turn that was streaming when the browser tore the connection down. */
const DROPPED: ChatStatus[] = ["submitted", "streaming", "error"];

/** A turn the server refused before any of it arrived. */
const REFUSED: ChatStatus[] = ["submitted", "error"];

beforeEach(() => {
  harness.swrCalls = [];
  harness.data = new Map<string, unknown>([
    ["/providers", { results: [provider] }],
  ]);
  harness.responses = new Map();
  harness.turn = { status: "ready", error: undefined, messages: [] };
  harness.setMessages.mockReset();
  harness.sendMessage.mockReset();
  harness.chatMutate.mockReset();
  harness.chatMutate.mockResolvedValue(undefined);
});

describe("Chat detail read", () => {
  // A brand-new Chat is read before its row exists. `fetcher` throwing on that
  // 404 is what put an error in the cache, and SWR does not revalidate on an
  // interval while one is there.
  it("reads through the fetcher that treats a missing row as absence", () => {
    renderChat();

    expect(chatReadConfig().fetcher).toBe(optionalFetcher);
  });

  // Every other read keeps the throwing contract; the concession is per-key.
  it("leaves the other reads on the shared fetcher", () => {
    renderChat();

    const others = harness.swrCalls.filter((c) => c.key !== CHAT_KEY);
    expect(others.length).toBeGreaterThan(0);
    for (const call of others) {
      expect(call.fetcher).not.toBe(optionalFetcher);
    }
  });

  // The trap the original code fell into: focus and reconnect revalidation were
  // switched off, which removed the only two triggers left once the interval
  // was inert. They are the "user came back" and "network returned" signals.
  it("leaves focus and reconnect revalidation on", () => {
    renderChat();

    const { config } = chatReadConfig();
    expect(config?.revalidateOnFocus).toBeUndefined();
    expect(config?.revalidateOnReconnect).toBeUndefined();
  });
});

// The wiring the pure-function tests cannot see. Gating the interval on the
// fetched status ALONE is the bootstrap deadlock: on an existing Chat that
// status is the previous turn's `succeeded` until something refetches it, and
// the only thing that would was the poll.
describe("polling a live run", () => {
  it("polls a turn this tab just submitted, though the row reads succeeded", () => {
    harness.turn.status = "submitted";
    renderChat();

    expect(pollFor({ status: "succeeded" })).toBe(CHAT_POLL_INTERVAL_MS);
  });

  it("polls while this tab is streaming", () => {
    harness.turn.status = "streaming";
    renderChat();

    expect(pollFor({ status: "succeeded" })).toBe(CHAT_POLL_INTERVAL_MS);
  });

  // A brand-new Chat has no row to read a status off at all.
  it("polls a turn on a Chat with no row yet", () => {
    harness.turn.status = "submitted";
    renderChat();

    expect(pollFor(null)).toBe(CHAT_POLL_INTERVAL_MS);
  });

  it("polls a run this tab did not start", () => {
    renderChat();

    expect(pollFor({ status: "running" })).toBe(CHAT_POLL_INTERVAL_MS);
  });

  // The recovery itself. A dropped stream leaves the turn at `error` while the
  // run carries on, and this is the reading that gets the answer moving again.
  it("keeps polling after a stream drops while the run is still going", () => {
    harness.data.set(`/chat/${CHAT_ID}`, { status: "running", messages: [] });
    renderThrough(...DROPPED);

    expect(pollFor({ status: "running" })).toBe(CHAT_POLL_INTERVAL_MS);
  });

  // Nothing streamed, so the server never took a run: polling for an outcome
  // that will never come would spin for the life of the page.
  it("does not poll a turn the server refused", () => {
    renderThrough(...REFUSED);

    expect(pollFor(null)).toBe(0);
  });

  it("does not poll an idle Chat", () => {
    renderChat();

    expect(pollFor({ status: "succeeded" })).toBe(0);
  });
});

// Monotonic hydration, at the seam: the effect reads the fetched row and hands
// `setMessages` an updater rather than a list, so what lands is decided against
// whatever is on screen at that moment.
describe("applying a fetched snapshot", () => {
  const applied = (held: PlatypusUIMessage[]) => {
    const update = harness.setMessages.mock.calls.at(-1)?.[0] as (
      held: PlatypusUIMessage[],
    ) => PlatypusUIMessage[];
    expect(typeof update).toBe("function");
    return update(held);
  };

  it("hydrates an empty transcript from the row", () => {
    const snapshot = [message("u1", "q"), message("a1", "an answer")];
    harness.data.set(`/chat/${CHAT_ID}`, {
      status: "succeeded",
      messages: snapshot,
    });
    renderChat();

    expect(applied([])).toBe(snapshot);
  });

  // The row is written on a flush interval, so a snapshot fetched mid-run lags
  // the stream. Applying it would make the answer visibly shorten.
  it("refuses a snapshot behind what is on screen", () => {
    harness.data.set(`/chat/${CHAT_ID}`, {
      status: "running",
      messages: [message("u1", "q"), message("a1", "the first third")],
    });
    renderThrough(...DROPPED);

    const held = [
      message("u1", "q"),
      message("a1", "the first third and then some more of it"),
    ];
    expect(applied(held)).toBe(held);
  });

  it("applies a snapshot that has moved on", () => {
    const snapshot = [
      message("u1", "q"),
      message("a1", "the first third and then the rest of the answer"),
    ];
    harness.data.set(`/chat/${CHAT_ID}`, {
      status: "running",
      messages: snapshot,
    });
    renderThrough(...DROPPED);

    expect(applied([message("u1", "q"), message("a1", "the first")])).toBe(
      snapshot,
    );
  });

  // A live stream is left alone entirely — the guard that predates this change.
  it("does not touch the transcript while this tab is streaming", () => {
    harness.turn.status = "streaming";
    harness.data.set(`/chat/${CHAT_ID}`, {
      status: "running",
      messages: [message("u1", "q")],
    });
    renderChat();

    expect(harness.setMessages).not.toHaveBeenCalled();
  });
});

// Which surface an error selects. The reported symptom was a modal telling the
// user their turn had failed while the run was healthy and still going.
describe("routing a chat error", () => {
  const RECOVERING = /Connection interrupted/;

  it("shows an inline line and no modal when the run is still going", () => {
    harness.data.set(`/chat/${CHAT_ID}`, { status: "running", messages: [] });
    const { container, queryByRole } = renderThrough(...DROPPED);

    expect(container.textContent).toMatch(RECOVERING);
    expect(queryByRole("dialog")).toBeNull();
  });

  // The run finished while the connection was gone, so there is nothing to
  // report and nothing to wait for — the snapshot already holds the answer.
  it("says nothing once the run has finished behind the drop", () => {
    harness.data.set(`/chat/${CHAT_ID}`, { status: "succeeded", messages: [] });
    const { container, queryByRole } = renderThrough(...DROPPED);

    expect(container.textContent).not.toMatch(RECOVERING);
    expect(queryByRole("dialog")).toBeNull();
  });

  it("opens the modal for a run that reached a terminal failed status", () => {
    harness.data.set(`/chat/${CHAT_ID}`, { status: "failed", messages: [] });
    const { container, getByRole } = renderThrough(...DROPPED);

    expect(getByRole("dialog")).toBeInTheDocument();
    expect(container.textContent).not.toMatch(RECOVERING);
  });

  // Nothing streamed, so the server never took a run: a rejected attachment, a
  // refused submission. The user has to be told.
  it("opens the modal for a request that never established", () => {
    harness.data.set(`/chat/${CHAT_ID}`, { status: "succeeded", messages: [] });
    const { container, getByRole } = renderThrough(...REFUSED);

    expect(getByRole("dialog")).toBeInTheDocument();
    expect(container.textContent).not.toMatch(RECOVERING);
  });

  it("says nothing at all while a turn is healthy", () => {
    harness.data.set(`/chat/${CHAT_ID}`, { status: "running", messages: [] });
    const { container, queryByRole } = renderChat();

    expect(container.textContent).not.toMatch(RECOVERING);
    expect(queryByRole("dialog")).toBeNull();
  });
});

// The composer guard. The old predicate required the local status to be `ready`,
// which is the one reading a dropped stream never has.
describe("holding the composer", () => {
  it("holds it after a stream drops mid-run", () => {
    harness.data.set(`/chat/${CHAT_ID}`, { status: "running", messages: [] });
    const { getByPlaceholderText, getByTestId } = renderThrough(...DROPPED);

    expect(getByPlaceholderText("Run in progress…")).toBeDisabled();
    expect(getByTestId("submit")).toHaveAttribute("data-status", "streaming");
  });

  it("holds it for a tab that arrived mid-run", () => {
    harness.data.set(`/chat/${CHAT_ID}`, { status: "running", messages: [] });
    const { getByPlaceholderText } = renderChat();

    expect(getByPlaceholderText("Run in progress…")).toBeDisabled();
  });

  // Once the run is over the composer comes back, and the submit button must
  // not keep a failure icon on it — the local status is still `error`.
  it("releases it once the run is over, with no failure on the button", () => {
    harness.data.set(`/chat/${CHAT_ID}`, { status: "succeeded", messages: [] });
    const { getByPlaceholderText, getByTestId } = renderThrough(...DROPPED);

    expect(
      getByPlaceholderText("What would you like to know?"),
    ).not.toBeDisabled();
    expect(getByTestId("submit")).toHaveAttribute("data-status", "ready");
  });

  it("keeps the error reading for a turn that actually failed", () => {
    harness.data.set(`/chat/${CHAT_ID}`, { status: "failed", messages: [] });
    const { getByTestId } = renderThrough(...DROPPED);

    expect(getByTestId("submit")).toHaveAttribute("data-status", "error");
  });
});

/**
 * The wiring an edit runs through (issue #710). The pieces have their own
 * tests; what those cannot see is whether the Chat actually hands the edit
 * surface the message's parts and resubmits what comes back. The original
 * defect was exactly here: the surface was handed a string, so a message with
 * a file resubmitted without it.
 */
describe("editing a message", () => {
  const report: FileUIPart = {
    type: "file",
    url: "https://files.example.com/report.pdf",
    mediaType: "application/pdf",
    filename: "report.pdf",
  };

  const withAttachment = (): PlatypusUIMessage =>
    ({
      id: "u1",
      role: "user",
      parts: [report, { type: "text", text: "What does this say?" }],
    }) as PlatypusUIMessage;

  const openEditOn = (id: string) => {
    renderChat();
    fireEvent.click(screen.getByRole("button", { name: `Edit ${id}` }));
  };

  it("opens the edit surface on the message's text and attachments", () => {
    harness.turn.messages = [withAttachment()];

    openEditOn("u1");

    expect(screen.getByTestId("editor")).toHaveAttribute(
      "data-text",
      "What does this say?",
    );
    expect(screen.getByText("report.pdf")).toBeInTheDocument();
  });

  it("resubmits the edit with its attachments and the current request body", () => {
    harness.turn.messages = [withAttachment()];

    openEditOn("u1");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(harness.sendMessage).toHaveBeenCalledWith(
      { text: "What does this say? (edited)", files: [report] },
      { body: expect.objectContaining({ providerId: expect.anything() }) },
    );
  });

  it("truncates the transcript at the edited message", () => {
    harness.turn.messages = [
      withAttachment(),
      message("a1", "It says X."),
      message("u2", "And this?"),
    ];

    openEditOn("u2");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(harness.setMessages).toHaveBeenCalledWith(
      harness.turn.messages.slice(0, 2),
    );
  });

  it("closes the surface once the edit is sent", () => {
    harness.turn.messages = [withAttachment()];

    openEditOn("u1");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(screen.queryByTestId("editor")).toBeNull();
  });

  it("edits one message at a time", () => {
    harness.turn.messages = [withAttachment(), message("u2", "And this?")];

    openEditOn("u1");

    expect(screen.getAllByTestId("editor")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Edit u2" })).toBeInTheDocument();
  });
});
