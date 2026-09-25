import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { ChatStatus, FileUIPart, PrepareSendMessagesRequest } from "ai";
import type { PlatypusUIMessage } from "@platypus/backend/src/types";
import { reportPdf } from "@/lib/chat-test-fixtures";
import {
  jsonResponse,
  stubAcceptedSave,
  stubRejectedSave,
} from "@/lib/test-utils";
import type { AlternativePosition } from "@/lib/chat-alternatives";

type PrepareRequest = PrepareSendMessagesRequest<PlatypusUIMessage>;

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
    auth: { user: { id: "u1" }, ownsWorkspace: true, isAuthLoading: false },
    turn: {
      status: "ready" as ChatStatus,
      error: undefined as Error | undefined,
      messages: [] as PlatypusUIMessage[],
    },
    setMessages: vi.fn(),
    sendMessage: vi.fn(),
    regenerate: vi.fn(),
    stop: vi.fn(),
    toastError: vi.fn(),
    chatMutate: vi.fn(),
    agentsMutate: vi.fn(),
    chatMessageRenders: 0,
    lastChatMessageProps: null as null | {
      onMessageDelete: (messageId: string) => void;
      onRegenerate?: (messageId: string) => void;
      onSwitchAlternative: (fromId: string, toId: string) => void;
      staleToolCallIds?: ReadonlySet<string>;
    },
    /** What the Chat configured the chat hook with. */
    chatOptions: undefined as
      undefined | { transport: { prepareSendMessagesRequest: PrepareRequest } },
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
        mutate: key.includes("/chat/")
          ? harness.chatMutate
          : key.endsWith("/agents")
            ? harness.agentsMutate
            : vi.fn(),
      };
      harness.responses.set(key, response);
    }
    return response;
  },
  useSWRConfig: () => ({ mutate: vi.fn() }),
}));

vi.mock("@ai-sdk/react", () => ({
  useChat: (options: typeof harness.chatOptions) => {
    harness.chatOptions = options;
    return useChatState();
  },
}));

const useChatState = () => ({
  messages: harness.turn.messages,
  setMessages: harness.setMessages,
  sendMessage: harness.sendMessage,
  status: harness.turn.status,
  error: harness.turn.error,
  regenerate: harness.regenerate,
  stop: harness.stop,
});

vi.mock("@/components/auth-provider", () => ({
  useBackendUrl: () => "http://test",
  useAuth: () => harness.auth,
}));
vi.mock("sonner", () => ({
  toast: { error: harness.toastError, info: vi.fn() },
}));

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
  // A form handing back a fixed message, so a composer send can be driven
  // without the real input's state.
  PromptInput: ({
    children,
    onSubmit,
  }: {
    children?: React.ReactNode;
    onSubmit: (message: { text: string; files: FileUIPart[] }) => void;
  }) => (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit({ text: "Hello", files: [] });
      }}
    >
      {children}
    </form>
  ),
  PromptInputBody: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
  PromptInputFooter: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
  PromptInputTools: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
  PromptInputAttachments: () => null,
  PromptInputAttachment: () => null,
  PromptInputActionMenu: () => null,
  PromptInputActionMenuTrigger: () => null,
  PromptInputActionMenuContent: () => null,
  PromptInputActionAddAttachments: () => null,
  PromptInputButton: ({
    children,
    onClick,
    variant,
  }: {
    children?: React.ReactNode;
    onClick?: () => void;
    variant?: string;
  }) => (
    <button type="button" data-variant={variant} onClick={onClick}>
      {children}
    </button>
  ),
  PromptInputSpeechButton: () => null,
  PromptInputTextarea: ({
    placeholder,
    disabled,
    status,
    value,
    onChange,
  }: {
    placeholder?: string;
    disabled?: boolean;
    status?: string;
    value?: string;
    onChange?: React.ChangeEventHandler<HTMLTextAreaElement>;
  }) => (
    <textarea
      placeholder={placeholder}
      disabled={disabled}
      data-status={status}
      value={value}
      onChange={onChange}
    />
  ),
  PromptInputSubmit: ({ status }: { status?: string }) => (
    <button type="submit" data-testid="submit" data-status={status} />
  ),
}));

// Stubbed to the edit seam: an Edit button per message, a Regenerate wherever
// the Chat hands one down, arrows wherever it hands down Alternatives, and
// whatever edit surface the Chat hands down for the one being edited. The
// transcript itself is `chat-message`'s own test's business.
vi.mock("./chat-message", () => ({
  ChatMessage: ({
    message,
    editor,
    onEditStart,
    onMessageDelete,
    onRegenerate,
    alternatives,
    onSwitchAlternative,
    staleToolCallIds,
  }: {
    message: PlatypusUIMessage;
    editor?: React.ReactNode;
    onEditStart: (messageId: string) => void;
    onMessageDelete: (messageId: string) => void;
    onRegenerate?: (messageId: string) => void;
    alternatives?: AlternativePosition;
    onSwitchAlternative: (fromId: string, toId: string) => void;
    staleToolCallIds?: ReadonlySet<string>;
  }) => {
    harness.chatMessageRenders += 1;
    harness.lastChatMessageProps = {
      onMessageDelete,
      onRegenerate,
      onSwitchAlternative,
      staleToolCallIds,
    };
    return (
      <div>
        {editor ?? (
          <>
            <button type="button" onClick={() => onEditStart(message.id)}>
              Edit {message.id}
            </button>
            <button type="button" onClick={() => onMessageDelete(message.id)}>
              Delete {message.id}
            </button>
            {onRegenerate && (
              <button type="button" onClick={() => onRegenerate(message.id)}>
                Regenerate {message.id}
              </button>
            )}
            {alternatives && (
              <span>
                {message.id} {alternatives.index + 1}/{alternatives.count}
              </span>
            )}
            {alternatives?.previousId && (
              <button
                type="button"
                onClick={() =>
                  onSwitchAlternative(message.id, alternatives.previousId!)
                }
              >
                Previous {message.id}
              </button>
            )}
            {alternatives?.nextId && (
              <button
                type="button"
                onClick={() =>
                  onSwitchAlternative(message.id, alternatives.nextId!)
                }
              >
                Next {message.id}
              </button>
            )}
          </>
        )}
      </div>
    );
  },
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
vi.mock("./context-meter", () => ({
  ContextMeter: () => null,
  ContextMeterEntrance: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));
vi.mock("./file-compatibility-warning", () => ({
  FileCompatibilityWarning: () => null,
}));
vi.mock("./no-providers-empty-state", () => ({
  NoProvidersEmptyState: () => null,
}));
vi.mock("./model-selector-dialog", () => ({ ModelSelectorDialog: () => null }));
vi.mock("./agent-info-dialog", () => ({
  AgentInfoDialog: ({ onClose }: { onClose: () => void }) => (
    <button type="button" onClick={onClose}>
      Close info
    </button>
  ),
}));

vi.mock("./chat-settings-dialog", () => ({
  ChatSettingsDialog: () => null,
}));
vi.mock("./chat-error-dialog", () => ({
  ChatErrorDialog: ({
    isOpen,
    onOpenChange,
  }: {
    isOpen: boolean;
    onOpenChange: (open: boolean) => void;
  }) =>
    isOpen ? (
      <div role="dialog">
        Chat Error
        <button type="button" onClick={() => onOpenChange(false)}>
          Dismiss error
        </button>
      </div>
    ) : null,
}));

import { Chat } from "./chat";
import { optionalFetcher } from "@/lib/utils";
import { CHAT_POLL_INTERVAL_MS } from "@/lib/chat-recovery";
import { CHAT_MAX_STEPS_ERROR } from "@/lib/chat-turn";

const CHAT_ID = "chat-1";
const CHAT_KEY = `http://test/organizations/org1/workspaces/ws1/chat/${CHAT_ID}`;

const provider = {
  id: "p1",
  name: "OpenRouter",
  modelIds: [{ id: "m1", passthroughFileTypes: [], contextWindow: 1000 }],
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

/** Two Providers differing only in whether they can search. */
const searchProvider = {
  id: "ps",
  name: "Searchable",
  searchSource: "tavily",
  modelIds: [{ id: "ms", passthroughFileTypes: [] }],
};
const plainProvider = {
  id: "pp",
  name: "Plain",
  searchSource: "none",
  modelIds: [{ id: "mp", passthroughFileTypes: [] }],
};
const agentOn = (id: string, providerId: string, modelId: string) => ({
  id,
  name: id,
  providerId,
  modelId,
});

const searchAgents = [
  agentOn("as", "ps", "ms"),
  agentOn("as2", "ps", "ms"),
  agentOn("ap", "pp", "mp"),
];

/**
 * Renders the Chat pointed at one of `searchAgents` via `?agentId=`, so the
 * resolved model — and with it the search toggle — can be switched between
 * renders by changing that prop.
 */
const renderWithAgent = (agentId: string) => {
  harness.data.set("/providers", {
    results: [searchProvider, plainProvider],
  });
  harness.data.set("/agents", { results: searchAgents });
  return render(
    <Chat
      orgId="org1"
      workspaceId="ws1"
      chatId={CHAT_ID}
      initialAgentId={agentId}
    />,
  );
};

/** The search toggle's Globe control, present only when the model can search. */
const searchToggle = () =>
  document.querySelector("svg.lucide-globe")?.closest("button") ?? null;
const searchIsOn = () =>
  searchToggle()?.getAttribute("data-variant") === "default";

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
  harness.auth = {
    user: { id: "u1" },
    ownsWorkspace: true,
    isAuthLoading: false,
  };
  localStorage.clear();
  harness.setMessages.mockReset();
  harness.sendMessage.mockReset();
  harness.regenerate.mockReset();
  harness.stop.mockReset();
  harness.toastError.mockReset();
  harness.chatMutate.mockReset();
  harness.chatMutate.mockResolvedValue(undefined);
  harness.agentsMutate.mockReset();
  harness.agentsMutate.mockResolvedValue(undefined);
  harness.chatMessageRenders = 0;
  harness.lastChatMessageProps = null;
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

  // Deleting every message reaches other tabs, and a reload too.
  it("applies an emptied Chat", () => {
    harness.data.set(`/chat/${CHAT_ID}`, { status: "succeeded", messages: [] });
    renderChat();

    expect(applied([message("u1", "q")])).toEqual([]);
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

// The server owns the Transcript (ADR-0026): a turn sends what is new, never
// the history, and a delete is stored the moment it is clicked.
describe("the server-owned Transcript", () => {
  afterEach(() => vi.unstubAllGlobals());

  const prepare = (options: Partial<Parameters<PrepareRequest>[0]>) => {
    renderChat();
    return harness.chatOptions!.transport.prepareSendMessagesRequest({
      id: CHAT_ID,
      messages: [],
      body: { providerId: "p1" },
      requestMetadata: undefined,
      headers: undefined,
      credentials: undefined,
      api: "",
      trigger: "submit-message",
      messageId: undefined,
      ...options,
    }) as { body: Record<string, unknown> };
  };

  it("sends a new message with the id it follows, and no history", () => {
    const next = message("u2", "follow up");

    const { body } = prepare({
      messages: [message("u1", "q"), message("a1", "a"), next],
    });

    expect(body).toEqual({
      providerId: "p1",
      id: CHAT_ID,
      message: next,
      parentId: "a1",
    });
  });

  it("sends a new message under the parent an edit names", () => {
    const { body } = prepare({
      messages: [message("u1", "q"), message("u2-edit", "q2")],
      body: { providerId: "p1", parentId: "a1" },
    });

    expect(body).toEqual({
      providerId: "p1",
      id: CHAT_ID,
      message: message("u2-edit", "q2"),
      parentId: "a1",
    });
  });

  it("sends a Chat's first message as following nothing", () => {
    const { body } = prepare({ messages: [message("u1", "q")] });

    expect(body.parentId).toBeNull();
  });

  it("sends a regenerate as the reply to regenerate, and no message", () => {
    const { body } = prepare({
      messages: [message("u1", "q")],
      trigger: "regenerate-message",
      messageId: "a1",
    });

    expect(body).toEqual({
      providerId: "p1",
      id: CHAT_ID,
      trigger: "regenerate-message",
      messageId: "a1",
    });
  });

  it("deletes on the server, then reads the row back", async () => {
    const fetchMock = stubAcceptedSave({ message: "Message deleted" });
    harness.turn.messages = [message("u1", "q"), message("a1", "a")];
    renderChat();

    fireEvent.click(screen.getByRole("button", { name: "Delete u1" }));

    await waitFor(() => expect(harness.chatMutate).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      "http://test/organizations/org1/workspaces/ws1/chat/chat-1/messages/u1",
      expect.objectContaining({ method: "DELETE" }),
    );
    // Nothing is cut locally: what the server now holds is what lands.
    expect(harness.setMessages).not.toHaveBeenCalled();
  });

  it("says so when the delete is refused, and leaves the transcript", async () => {
    stubRejectedSave("A reply is still being written in this Chat", 409);
    harness.turn.messages = [message("u1", "q"), message("a1", "a")];
    renderChat();

    fireEvent.click(screen.getByRole("button", { name: "Delete u1" }));

    await waitFor(() =>
      expect(harness.toastError).toHaveBeenCalledWith(
        "A reply is still being written in this Chat",
      ),
    );
    expect(harness.chatMutate).not.toHaveBeenCalled();
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

  // Keyed on the error so the modal can be dismissed while the error persists;
  // a later, different error still reopens it.
  it("reopens for a second, different failure after being dismissed", () => {
    harness.data.set(`/chat/${CHAT_ID}`, { status: "failed", messages: [] });
    const view = renderThrough(...DROPPED);
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss error" }));
    expect(screen.queryByRole("dialog")).toBeNull();

    harness.turn.error = new Error("a second failure");
    view.rerender(<Chat orgId="org1" workspaceId="ws1" chatId={CHAT_ID} />);

    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});

/**
 * The search toggle's invariant (issue #624): search may not be on when the
 * resolved selection cannot search. The control only ever forces the toggle
 * off, and only when the resolved model's `canSearch` actually changes — not
 * on every Agent/Provider/model identity change, and not while resolution is
 * briefly unknown.
 */
describe("the search toggle", () => {
  it("starts off", () => {
    renderWithAgent("as");

    expect(searchToggle()).toBeInTheDocument();
    expect(searchIsOn()).toBe(false);
  });

  it("stays on switching between two selections that can both search", () => {
    const view = renderWithAgent("as");

    fireEvent.click(searchToggle()!);
    expect(searchIsOn()).toBe(true);

    view.rerender(
      <Chat
        orgId="org1"
        workspaceId="ws1"
        chatId={CHAT_ID}
        initialAgentId="as2"
      />,
    );

    expect(searchIsOn()).toBe(true);
  });

  it("forces off when switching to a selection that cannot search", () => {
    const view = renderWithAgent("as");

    fireEvent.click(searchToggle()!);
    expect(searchIsOn()).toBe(true);

    // The non-searching selection has no Globe at all.
    view.rerender(
      <Chat
        orgId="org1"
        workspaceId="ws1"
        chatId={CHAT_ID}
        initialAgentId="ap"
      />,
    );
    expect(searchToggle()).toBeNull();

    // Back on a searching selection, the toggle was forced off, not restored.
    view.rerender(
      <Chat
        orgId="org1"
        workspaceId="ws1"
        chatId={CHAT_ID}
        initialAgentId="as"
      />,
    );
    expect(searchIsOn()).toBe(false);
  });

  it("does not turn back on switching from a non-searching to a searching selection", () => {
    const view = renderWithAgent("ap");

    expect(searchToggle()).toBeNull();

    view.rerender(
      <Chat
        orgId="org1"
        workspaceId="ws1"
        chatId={CHAT_ID}
        initialAgentId="as"
      />,
    );

    expect(searchIsOn()).toBe(false);
  });

  it("does nothing while the selection is unresolved, preserving the setting", () => {
    const view = renderWithAgent("as");

    fireEvent.click(searchToggle()!);
    expect(searchIsOn()).toBe(true);

    // A brief loading/revalidation gap: nothing resolves, so no Globe.
    harness.data.set("/providers", { results: [] });
    harness.responses = new Map();
    view.rerender(
      <Chat
        orgId="org1"
        workspaceId="ws1"
        chatId={CHAT_ID}
        initialAgentId="as"
      />,
    );
    expect(searchToggle()).toBeNull();

    // Providers return; the User's setting must survive the gap.
    harness.data.set("/providers", {
      results: [searchProvider, plainProvider],
    });
    harness.responses = new Map();
    view.rerender(
      <Chat
        orgId="org1"
        workspaceId="ws1"
        chatId={CHAT_ID}
        initialAgentId="as"
      />,
    );

    expect(searchIsOn()).toBe(true);
  });
});

/**
 * Whether the turn's stream ever established, judged per turn. The refused case
 * is already covered above; this pins the reset, so a second turn is not judged
 * on the first turn's stream.
 */
describe("turn establishment", () => {
  it("judges a second turn on its own stream, not an earlier turn's", () => {
    harness.data.set(`/chat/${CHAT_ID}`, { status: "succeeded", messages: [] });
    const { getByRole } = renderThrough(
      "submitted",
      "streaming",
      "ready",
      "submitted",
      "error",
    );

    expect(getByRole("dialog")).toBeInTheDocument();
  });

  // Once established, it stays established while the broken turn sits there:
  // repeated `error` renders must not re-open the modal or drop the answer.
  it("keeps the answer while a broken turn sits there", () => {
    harness.data.set(`/chat/${CHAT_ID}`, { status: "running", messages: [] });
    const { container, queryByRole } = renderThrough(
      "submitted",
      "streaming",
      "error",
      "error",
    );

    expect(container.textContent).toMatch(/Connection interrupted/);
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
  const withAttachment = (): PlatypusUIMessage =>
    ({
      id: "u1",
      role: "user",
      parts: [reportPdf, { type: "text", text: "What does this say?" }],
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
      { text: "What does this say? (edited)", files: [reportPdf] },
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

    const update = harness.setMessages.mock.calls.at(-1)?.[0] as (
      held: PlatypusUIMessage[],
    ) => PlatypusUIMessage[];
    expect(update(harness.turn.messages)).toEqual(
      harness.turn.messages.slice(0, 2),
    );
  });

  // u2 answers a1, which was deleted: on screen u1 is above u2, but the edit
  // belongs beside u2, under a1.
  it("sends the edit under the edited message's own parent", () => {
    harness.data.set(`/chat/${CHAT_ID}`, {
      status: "succeeded",
      messages: [],
      tree: [
        { id: "u1", parentId: null },
        { id: "u2", parentId: "a1" },
      ],
    });
    harness.turn.messages = [withAttachment(), message("u2", "And this?")];

    openEditOn("u2");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(harness.sendMessage).toHaveBeenCalledWith(expect.anything(), {
      body: expect.objectContaining({ parentId: "a1" }),
    });
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

/**
 * Every entry point starts its turn through `useChatTurn` (issue #971); the
 * rules themselves are pinned there. What this file can see is that the Chat
 * actually routes Regenerate and the composer through it.
 */
describe("starting a turn", () => {
  const directRow = (maxSteps: number) => ({
    id: CHAT_ID,
    status: "succeeded",
    providerId: "p1",
    modelId: "m1",
    maxSteps,
    messages: [],
  });

  it("refuses a Regenerate with an out-of-range Max steps", () => {
    harness.data.set(`/chat/${CHAT_ID}`, directRow(51));
    harness.turn.messages = [message("u1", "q"), message("a1", "a")];
    renderChat();

    fireEvent.click(screen.getByRole("button", { name: "Regenerate a1" }));

    expect(harness.toastError).toHaveBeenCalledWith(CHAT_MAX_STEPS_ERROR);
    expect(harness.regenerate).not.toHaveBeenCalled();
    expect(harness.chatMutate).not.toHaveBeenCalled();
  });

  it("regenerates with the turn's body and refreshes the row", () => {
    harness.data.set(`/chat/${CHAT_ID}`, directRow(10));
    harness.turn.messages = [message("u1", "q"), message("a1", "a")];
    renderChat();

    fireEvent.click(screen.getByRole("button", { name: "Regenerate a1" }));

    expect(harness.regenerate).toHaveBeenCalledWith({
      body: expect.objectContaining({ providerId: "p1", maxSteps: 10 }),
      messageId: "a1",
    });
    expect(harness.chatMutate).toHaveBeenCalledTimes(1);
  });

  // The reply's message was deleted: there is nothing to answer, and the
  // server refuses the regenerate (409).
  it("offers no Regenerate once the reply's message has left the Chat", () => {
    harness.data.set(`/chat/${CHAT_ID}`, {
      ...directRow(10),
      tree: [
        { id: "u1", parentId: null },
        { id: "a1", parentId: "u1" },
        { id: "a2", parentId: "u2" },
      ],
    });
    harness.turn.messages = [
      message("u1", "q"),
      message("a1", "a"),
      message("a2", "an answer to a deleted question"),
    ];
    renderChat();

    expect(screen.queryByRole("button", { name: "Regenerate a2" })).toBeNull();
  });

  it("offers Regenerate on every reply, not only the last", () => {
    harness.data.set(`/chat/${CHAT_ID}`, directRow(10));
    harness.turn.messages = [
      message("u1", "q"),
      message("a1", "a"),
      message("u2", "q2"),
      message("a2", "a2"),
    ];
    renderChat();

    fireEvent.click(screen.getByRole("button", { name: "Regenerate a1" }));

    expect(screen.getByRole("button", { name: "Regenerate a2" })).toBeTruthy();
    expect(harness.regenerate).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "a1" }),
    );
  });

  it("offers Regenerate on a reply the tree does not list yet", () => {
    harness.data.set(`/chat/${CHAT_ID}`, {
      ...directRow(10),
      tree: [{ id: "u1", parentId: null }],
    });
    harness.turn.messages = [
      message("u1", "q"),
      message("a1", "just streamed"),
    ];
    renderChat();

    expect(
      screen.getByRole("button", { name: "Regenerate a1" }),
    ).toBeInTheDocument();
  });

  // The #648 refresh: the row has to learn the new turn's status at submit.
  it("refreshes the row after a composer send", () => {
    harness.data.set(`/chat/${CHAT_ID}`, directRow(10));
    renderChat();

    fireEvent.click(screen.getByTestId("submit"));

    expect(harness.sendMessage).toHaveBeenCalledWith(
      { text: "Hello", files: [] },
      { body: expect.objectContaining({ providerId: "p1" }) },
    );
    expect(harness.chatMutate).toHaveBeenCalledTimes(1);
  });
});

// Moving between Alternatives (#712): a local swap straight away, then the
// server's path. Nothing fetched in between may drag the view back.
describe("switching between Alternatives", () => {
  afterEach(() => vi.unstubAllGlobals());

  const SWITCH_URL = `${CHAT_KEY}/active-leaf`;

  /** u1 → a1 → u2 → a2 → u3 → a3, with u2 edited twice: u2b → a2b, and u2c. */
  const tree = [
    { id: "u1", parentId: null },
    { id: "a1", parentId: "u1" },
    { id: "u2", parentId: "a1" },
    { id: "a2", parentId: "u2" },
    { id: "u3", parentId: "a2" },
    { id: "a3", parentId: "u3" },
    { id: "u2b", parentId: "a1" },
    { id: "a2b", parentId: "u2b" },
    { id: "u2c", parentId: "a1" },
  ];
  const path = (...ids: string[]) => ids.map((id) => message(id, id));
  const original = path("u1", "a1", "u2", "a2", "u3", "a3");
  const edited = path("u1", "a1", "u2b", "a2b");
  const row = (messages: PlatypusUIMessage[]) => ({
    id: CHAT_ID,
    status: "succeeded",
    providerId: "p1",
    modelId: "m1",
    messages,
    tree,
  });

  /** What is on screen: the chat hook's messages, updated as the Chat sets them. */
  const onScreen = () => harness.turn.messages.map((m) => m.id);

  const rerenderChat = (view: ReturnType<typeof renderChat>) =>
    view.rerender(<Chat orgId="org1" workspaceId="ws1" chatId={CHAT_ID} />);

  /** A poll landing: the Chat read hands back a fresh row. */
  const pollLands = (
    view: ReturnType<typeof renderChat>,
    messages: PlatypusUIMessage[],
  ) => {
    const response = harness.responses.get(CHAT_KEY) as object;
    harness.responses.set(CHAT_KEY, { ...response, data: row(messages) });
    rerenderChat(view);
  };

  /** A PUT that answers only when the test says so. */
  const deferredFetch = () => {
    let answer!: (body: unknown, status?: number) => void;
    const fetchMock = vi.fn(
      () =>
        new Promise((resolve) => {
          answer = (body, status = 200) => resolve(jsonResponse(status, body));
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    return {
      fetchMock,
      answer: (body: unknown, status?: number) => answer(body, status),
    };
  };

  const showing = (held: PlatypusUIMessage[]) => {
    harness.data.set(`/chat/${CHAT_ID}`, row(held));
    harness.turn.messages = held;
    harness.setMessages.mockImplementation((update) => {
      harness.turn.messages =
        typeof update === "function" ? update(harness.turn.messages) : update;
    });
    return renderChat();
  };

  it("hands each message its position among its Alternatives", () => {
    showing(edited);

    expect(screen.getByText("u2b 2/3")).toBeInTheDocument();
    expect(screen.queryByText(/^a2b /)).toBeNull();
  });

  it.each([
    ["a longer path", edited, "Previous u2b", "u2", original],
    ["a shorter path", original, "Next u2", "u2b", edited],
  ])(
    "switches to %s and is not dragged back by a poll while the switch is pending",
    async (_, from, button, target, to) => {
      const { fetchMock, answer } = deferredFetch();
      const view = showing(from);

      fireEvent.click(screen.getByRole("button", { name: button }));

      // Straight away, without waiting on the server.
      expect(onScreen()).toEqual(["u1", "a1", target]);
      expect(fetchMock).toHaveBeenCalledWith(
        SWITCH_URL,
        expect.objectContaining({
          method: "PUT",
          body: JSON.stringify({ messageId: target }),
        }),
      );

      pollLands(view, from);
      expect(onScreen()).toEqual(["u1", "a1", target]);

      answer({ messages: to, tree });
      await waitFor(() => expect(onScreen()).toEqual(to.map((m) => m.id)));
      // Written into the read, so the next poll and the screen agree.
      const [update, options] = harness.chatMutate.mock.calls.at(-1)!;
      expect(options).toEqual({ revalidate: false });
      expect(update(row(from))).toEqual(row(to));

      // Released: a later poll lands as any other would.
      pollLands(view, edited);
      expect(onScreen()).toEqual(edited.map((m) => m.id));
    },
  );

  it("leaves a turn started while the switch was pending alone", async () => {
    const { answer } = deferredFetch();
    const view = showing(edited);

    fireEvent.click(screen.getByRole("button", { name: "Previous u2b" }));
    harness.turn.status = "streaming";
    rerenderChat(view);
    answer({ messages: original, tree });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onScreen()).toEqual(["u1", "a1", "u2"]);
    expect(harness.chatMutate).not.toHaveBeenCalled();
  });

  it("reverts and says so when the switch is refused", async () => {
    stubRejectedSave("A reply is still being written in this Chat", 409);
    showing(edited);

    fireEvent.click(screen.getByRole("button", { name: "Previous u2b" }));

    await waitFor(() =>
      expect(harness.toastError).toHaveBeenCalledWith(
        "A reply is still being written in this Chat",
      ),
    );
    expect(harness.turn.messages).toBe(edited);
    expect(harness.chatMutate).not.toHaveBeenCalled();
  });

  it("sends a later switch only once the earlier one has answered, and ends on the later", async () => {
    const answers: ((body: unknown) => void)[] = [];
    const fetchMock = vi.fn(
      () =>
        new Promise((resolve) => {
          answers.push((body) => resolve(jsonResponse(200, body)));
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const view = showing(original);

    fireEvent.click(screen.getByRole("button", { name: "Next u2" }));
    rerenderChat(view);
    fireEvent.click(screen.getByRole("button", { name: "Next u2b" }));

    // One request at a time, so the server saves them in click order.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onScreen()).toEqual(["u1", "a1", "u2c"]);

    // The earlier one answering changes nothing on screen.
    answers[0]({ messages: edited, tree });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock).toHaveBeenLastCalledWith(
      SWITCH_URL,
      expect.objectContaining({ body: JSON.stringify({ messageId: "u2c" }) }),
    );
    expect(onScreen()).toEqual(["u1", "a1", "u2c"]);

    const last = path("u1", "a1", "u2c");
    answers[1]({ messages: last, tree });
    await waitFor(() => expect(harness.chatMutate).toHaveBeenCalled());

    expect(onScreen()).toEqual(["u1", "a1", "u2c"]);
    expect(harness.toastError).not.toHaveBeenCalled();
  });

  it("sends only the last of the clicks made while a switch was in flight", async () => {
    const answers: ((body: unknown) => void)[] = [];
    const fetchMock = vi.fn(
      () =>
        new Promise((resolve) => {
          answers.push((body) => resolve(jsonResponse(200, body)));
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const view = showing(original);

    fireEvent.click(screen.getByRole("button", { name: "Next u2" }));
    rerenderChat(view);
    fireEvent.click(screen.getByRole("button", { name: "Next u2b" }));
    rerenderChat(view);
    fireEvent.click(screen.getByRole("button", { name: "Previous u2c" }));

    answers[0]({ messages: edited, tree });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock).toHaveBeenLastCalledWith(
      SWITCH_URL,
      expect.objectContaining({ body: JSON.stringify({ messageId: "u2b" }) }),
    );
  });

  it("reverts a run of switches to where the first one started", async () => {
    const { fetchMock, answer } = deferredFetch();
    const view = showing(original);

    fireEvent.click(screen.getByRole("button", { name: "Next u2" }));
    rerenderChat(view);
    fireEvent.click(screen.getByRole("button", { name: "Next u2b" }));
    answer({ error: "Request failed" }, 500);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    answer({ error: "Request failed" }, 500);

    await waitFor(() => expect(harness.toastError).toHaveBeenCalledTimes(1));
    expect(harness.turn.messages).toBe(original);
  });
});

/**
 * Issue #869: the transcript re-rendered on every streamed token and every
 * composer keystroke. `ChatMessage` is memoised, so what defeated it was the
 * props changing identity — the cleared-tool-call Set and the delete callback
 * — and the composer's input state living in `Chat`, so a keystroke re-rendered
 * the whole tree.
 */
describe("transcript stability", () => {
  it("keeps the stale tool-call set and the callbacks stable across renders", () => {
    harness.turn.messages = [message("u1", "q"), message("a1", "a")];
    const view = renderChat();
    const first = harness.lastChatMessageProps!;

    view.rerender(<Chat orgId="org1" workspaceId="ws1" chatId={CHAT_ID} />);

    expect(harness.lastChatMessageProps!.onMessageDelete).toBe(
      first.onMessageDelete,
    );
    expect(harness.lastChatMessageProps!.onRegenerate).toBe(first.onRegenerate);
    expect(harness.lastChatMessageProps!.onSwitchAlternative).toBe(
      first.onSwitchAlternative,
    );
    expect(harness.lastChatMessageProps!.staleToolCallIds).toBe(
      first.staleToolCallIds,
    );
  });

  it("does not re-render the transcript while the composer is typed into", () => {
    harness.turn.messages = [message("u1", "q"), message("a1", "a")];
    renderChat();
    const before = harness.chatMessageRenders;

    fireEvent.change(
      screen.getByPlaceholderText("What would you like to know?"),
      { target: { value: "hello" } },
    );

    expect(harness.chatMessageRenders).toBe(before);
  });

  // With clearing ACTIVE the set is non-empty, and the function rebuilds it
  // from `messages` — which changes on every streamed token. Identity has to
  // survive that too, or every token re-renders the transcript exactly when a
  // long chat (the reason clearing exists) is streaming (issue #869).
  it("keeps the cleared tool-call set stable while a reply streams", () => {
    harness.data.set(`/chat/${CHAT_ID}`, {
      id: CHAT_ID,
      status: "running",
      providerId: "p1",
      modelId: "m1",
      messages: [],
    });
    const toolResults = ["t0", "t1", "t2", "t3", "t4", "t5"].map(
      (toolCallId) =>
        ({
          id: `a-${toolCallId}`,
          role: "assistant",
          parts: [
            {
              type: "tool-read_url",
              toolCallId,
              state: "output-available",
              input: {},
              output: {},
            },
          ],
          metadata: {
            readOnlyToolNames: ["read_url"],
            // 700/1000 is at the clearing threshold; keep-recent is 4, so t0
            // and t1 are stale.
            contextOccupancy: { inputTokens: 700, outputTokens: 0 },
          },
        }) as unknown as PlatypusUIMessage,
    );
    harness.turn.messages = [...toolResults, message("a-last", "an answer")];
    const view = renderChat();
    const first = harness.lastChatMessageProps!.staleToolCallIds;
    expect(first?.size).toBe(2);

    harness.turn.messages = [
      ...toolResults,
      message("a-last", "an answer, still streaming"),
    ];
    view.rerender(<Chat orgId="org1" workspaceId="ws1" chatId={CHAT_ID} />);

    expect(harness.lastChatMessageProps!.staleToolCallIds).toBe(first);
  });
});

// An Agent carrying the agent-management tools can rewrite its own row mid-chat,
// and the write lands on the server: this read is not told, and no interval or
// mutate anywhere else touches it. The info dialog is the only place that
// configuration is shown, so opening it is the moment worth spending a request
// on (issue #920).
describe("the Agent behind the info dialog", () => {
  const openInfoDialog = () =>
    fireEvent.click(
      document.querySelector("svg.lucide-info")!.closest("button")!,
    );
  const closeInfoDialog = () =>
    fireEvent.click(screen.getByRole("button", { name: "Close info" }));

  it("does not re-read the Agents while the dialog is closed", () => {
    renderWithAgent("as");

    expect(harness.agentsMutate).not.toHaveBeenCalled();
  });

  it("re-reads the Agents when the dialog opens", () => {
    renderWithAgent("as");

    openInfoDialog();

    expect(harness.agentsMutate).toHaveBeenCalledTimes(1);
  });

  // The trigger is the open transition, not the render. A Chat re-renders on
  // every streamed chunk, and a request per chunk for a dialog that is already
  // showing the answer would be worse than the staleness it fixes.
  it("re-reads once, however many times it re-renders while open", () => {
    const view = renderWithAgent("as");
    openInfoDialog();

    view.rerender(
      <Chat
        orgId="org1"
        workspaceId="ws1"
        chatId={CHAT_ID}
        initialAgentId="as"
      />,
    );
    view.rerender(
      <Chat
        orgId="org1"
        workspaceId="ws1"
        chatId={CHAT_ID}
        initialAgentId="as"
      />,
    );

    expect(harness.agentsMutate).toHaveBeenCalledTimes(1);
  });

  it("re-reads again the next time the dialog is opened", () => {
    renderWithAgent("as");
    openInfoDialog();

    closeInfoDialog();
    openInfoDialog();

    expect(harness.agentsMutate).toHaveBeenCalledTimes(2);
  });

  // The dialog keeps showing the cached row when the re-read fails, which is
  // what it does without the re-read at all. Nothing to report, nothing to
  // leave unhandled.
  it("swallows a failed re-read", async () => {
    harness.agentsMutate.mockRejectedValue(new Error("offline"));
    renderWithAgent("as");

    expect(() => openInfoDialog()).not.toThrow();
    await Promise.resolve();
  });
});

/**
 * A new Chat's row is cached as absent by the index route, but SWR still
 * reports the key's first mount as loading. The selection must not wait on
 * that, or every New chat click paints the default placeholder and a pending
 * picker until the read settles (issue #966).
 */
describe("restoring the selection on a new Chat", () => {
  it("resolves the stored Agent while a cached absent row reads as loading", () => {
    harness.data.set("/agents", {
      results: [{ ...agentOn("a1", "p1", "m1"), inputPlaceholder: "Ask a1" }],
    });
    harness.responses.set(CHAT_KEY, {
      data: null,
      isLoading: true,
      mutate: harness.chatMutate,
    });
    localStorage.setItem(
      "platypus:workspace:ws1:lastSelection",
      JSON.stringify({
        value: { type: "agent", id: "a1" },
        expiresAt: Date.now() + 60_000,
      }),
    );

    renderChat();

    expect(screen.getByPlaceholderText("Ask a1")).toBeInTheDocument();
  });
});

/**
 * What stands in for the Chat until it can render for real. An existing Chat
 * must not paint the empty-chat layout (composer centred) while its transcript
 * is on the way, or the composer drops to the bottom once the messages land.
 * A new Chat has nothing to wait for and keeps the centred composer.
 */
describe("loading", () => {
  const PROVIDERS_KEY =
    "http://test/organizations/org1/workspaces/ws1/providers";
  const loadingSkeleton = () =>
    screen.queryByRole("status", { name: "Loading chat" });
  const composer = () =>
    screen.queryByPlaceholderText("What would you like to know?");
  const rowInFlight = () =>
    harness.responses.set(CHAT_KEY, {
      data: undefined,
      isLoading: true,
      mutate: harness.chatMutate,
    });
  const providersInFlight = () =>
    harness.responses.set(PROVIDERS_KEY, {
      data: undefined,
      isLoading: true,
      mutate: vi.fn(),
    });

  it("shows a centred composer skeleton for a new Chat while providers load", () => {
    providersInFlight();
    harness.data.set(`/chat/${CHAT_ID}`, null);

    renderChat();

    expect(loadingSkeleton()).toHaveClass("justify-center");
    expect(composer()).not.toBeInTheDocument();
  });

  it("shows the failure, not an endless skeleton, when providers fail to load", () => {
    harness.responses.set(PROVIDERS_KEY, {
      data: undefined,
      error: new Error("500"),
      isLoading: false,
      mutate: vi.fn(),
    });

    renderChat();

    expect(loadingSkeleton()).not.toBeInTheDocument();
    expect(screen.getByText(/Failed to load providers/)).toBeInTheDocument();
  });

  it("shows the transcript skeleton for an existing Chat while providers load", () => {
    providersInFlight();
    rowInFlight();

    renderChat();

    expect(loadingSkeleton()).not.toHaveClass("justify-center");
  });

  it("holds the skeleton, not a centred composer, while the row is in flight", () => {
    rowInFlight();

    renderChat();

    expect(loadingSkeleton()).not.toHaveClass("justify-center");
    expect(composer()).not.toBeInTheDocument();
  });

  it("holds it until the fetched messages reach the screen", () => {
    const messages = [message("u1", "q"), message("a1", "answer")];
    harness.data.set(`/chat/${CHAT_ID}`, { status: "succeeded", messages });

    const view = renderChat();
    expect(loadingSkeleton()).toBeInTheDocument();
    expect(composer()).not.toBeInTheDocument();

    harness.turn.messages = messages;
    view.rerender(<Chat orgId="org1" workspaceId="ws1" chatId={CHAT_ID} />);

    expect(loadingSkeleton()).not.toBeInTheDocument();
    expect(composer()).toBeInTheDocument();
  });

  // Until the row is read back after a delete, it still holds the messages the
  // screen has dropped; reading "row has messages, screen has none" as loading
  // would never let go.
  it("does not come back when every message is deleted", () => {
    const messages = [message("u1", "q")];
    harness.data.set(`/chat/${CHAT_ID}`, { status: "succeeded", messages });
    harness.turn.messages = messages;
    const view = renderChat();

    harness.turn.messages = [];
    view.rerender(<Chat orgId="org1" workspaceId="ws1" chatId={CHAT_ID} />);

    expect(loadingSkeleton()).not.toBeInTheDocument();
    expect(composer()).toBeInTheDocument();
  });

  it("renders an emptied Chat's composer, not an endless skeleton", () => {
    harness.data.set(`/chat/${CHAT_ID}`, { status: "succeeded", messages: [] });

    renderChat();

    expect(loadingSkeleton()).not.toBeInTheDocument();
    expect(composer()).toBeInTheDocument();
  });

  // Until the session and the Workspace row land, nobody knows whether the
  // reader may send. Guessing read-only and swapping to the composer is the
  // flicker a reload showed.
  describe("while ownership is unknown", () => {
    const messages = [message("u1", "q"), message("a1", "answer")];
    beforeEach(() => {
      harness.auth = {
        user: { id: "u1" },
        ownsWorkspace: false,
        isAuthLoading: true,
      };
      harness.data.set(`/chat/${CHAT_ID}`, { status: "succeeded", messages });
    });

    it("holds the skeleton, drawing the composer rather than the read-only notice", () => {
      renderChat();

      expect(loadingSkeleton()?.querySelector(".border-input")).toBeTruthy();
      expect(composer()).not.toBeInTheDocument();
      expect(screen.queryByText(/Read-only mode/)).toBeNull();
    });

    it("keeps the docked skeleton over messages that have already landed", () => {
      harness.turn.messages = messages;

      renderChat();

      expect(loadingSkeleton()).not.toHaveClass("justify-center");
    });
  });

  it("renders a new Chat's composer straight away", () => {
    harness.data.set(`/chat/${CHAT_ID}`, null);

    renderChat();

    expect(loadingSkeleton()).not.toBeInTheDocument();
    expect(composer()).toBeInTheDocument();
  });
});
