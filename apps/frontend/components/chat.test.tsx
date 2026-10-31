import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import {
  DefaultChatTransport,
  lastAssistantMessageIsCompleteWithApprovalResponses,
  type ChatStatus,
  type FileUIPart,
} from "ai";
import type { PlatypusUIMessage } from "@platypus/schemas";
import { alternativesRow, reportPdf } from "@/test/chat-test-fixtures";
import {
  stubAcceptedSave,
  stubPendingSave,
  stubRejectedSave,
} from "@/test/test-utils";
import type { AlternativePosition } from "@/lib/chat-alternatives";

/**
 * What the Chat component wires, not what the transcript read decides.
 *
 * The recovery decisions, the server-owned Transcript and the tree now live in
 * `hooks/use-chat-transcript.ts` and are tested there; what this file can see is
 * that the Chat hands those pieces to the presentational tree correctly — which
 * composer state a run belief produces, which of the two error surfaces a given
 * state selects, and that an edit, a send and a Regenerate reach `useChatTurn`.
 * The presentational tree is stubbed down to the props under test — this is not
 * a rendering test.
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
      status: "ready",
      error: undefined as Error | undefined,
      messages: [] as PlatypusUIMessage[],
    },
    setMessages: vi.fn(),
    sendMessage: vi.fn(),
    regenerate: vi.fn(),
    addToolApprovalResponse: vi.fn(),
    stop: vi.fn(),
    toastError: vi.fn(),
    toastInfo: vi.fn(),
    /** The Sandbox uploads the stubbed composer sends with its message. */
    sandboxFiles: [] as File[],
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
      | undefined
      | {
          transport: DefaultChatTransport<PlatypusUIMessage>;
          experimental_throttle?: number;
          sendAutomaticallyWhen?: unknown;
        },
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

function useChatState() {
  return {
    messages: harness.turn.messages,
    setMessages: harness.setMessages,
    sendMessage: harness.sendMessage,
    status: harness.turn.status,
    error: harness.turn.error,
    regenerate: harness.regenerate,
    addToolApprovalResponse: harness.addToolApprovalResponse,
    stop: harness.stop,
  };
}

vi.mock("@/components/auth-provider", () => ({
  useBackendUrl: () => "http://test",
  useAuth: () => harness.auth,
}));
vi.mock("sonner", () => ({
  toast: { error: harness.toastError, info: harness.toastInfo },
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
    onSubmit: (message: {
      text: string;
      files: FileUIPart[];
      sandboxFiles: File[];
    }) => Promise<void> | void;
  }) => (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        // The real input swallows a rejected Send and keeps the composer.
        void Promise.resolve(
          onSubmit({
            text: "Hello",
            files: [],
            sandboxFiles: harness.sandboxFiles,
          }),
        ).catch(() => {});
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
  PromptInputActionMenu: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
  PromptInputActionMenuTrigger: () => null,
  PromptInputActionMenuContent: ({
    children,
  }: {
    children?: React.ReactNode;
  }) => <div>{children}</div>,
  PromptInputActionAddAttachments: () => null,
  PromptInputActionAddSandboxUploads: () => <div>Upload to Sandbox</div>,
  usePromptInputAttachments: () => ({ files: [], sandboxFiles: [] }),
  PromptInputButton: ({
    children,
    variant,
    ...props
  }: React.ComponentProps<"button"> & { variant?: string }) => (
    <button type="button" data-variant={variant} {...props}>
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
  PromptInputSubmit: ({
    status,
    ...props
  }: React.ComponentProps<"button"> & { status?: string }) => (
    <button
      type="submit"
      data-testid="submit"
      data-status={status}
      {...props}
    />
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
    onApprovalResponse,
  }: {
    message: PlatypusUIMessage;
    editor?: React.ReactNode;
    onEditStart: (messageId: string) => void;
    onMessageDelete: (messageId: string) => void;
    onRegenerate?: (messageId: string) => void;
    alternatives?: AlternativePosition;
    onSwitchAlternative: (fromId: string, toId: string) => void;
    staleToolCallIds?: ReadonlySet<string>;
    onApprovalResponse?: (approvalId: string, approved: boolean) => void;
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
            {onApprovalResponse && (
              <button
                type="button"
                onClick={() => onApprovalResponse("ap1", true)}
              >
                Approve {message.id}
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
vi.mock("./context-meter", async (importOriginal) => {
  const contextMeter = await importOriginal<typeof import("./context-meter")>();
  return {
    ...contextMeter,
    ContextMeter: () => null,
    ContextMeterEntrance: ({ children }: { children?: React.ReactNode }) => (
      <div>{children}</div>
    ),
  };
});
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
import { prepareChatTurnRequest } from "@/lib/chat-transport";
import { optionalFetcher } from "@/lib/utils";
import { CHAT_MAX_STEPS_ERROR } from "@/lib/chat-turn";

const CHAT_ID = "chat-1";
const CHAT_KEY = `http://test/organizations/org1/workspaces/ws1/chat/${CHAT_ID}`;

const provider = {
  id: "p1",
  name: "OpenRouter",
  modelIds: [{ id: "m1", passthroughFileTypes: [], contextWindow: 1000 }],
};

function message(id: string, text: string): PlatypusUIMessage {
  return {
    id,
    role: id.startsWith("u") ? "user" : "assistant",
    parts: [{ type: "text", text }],
  };
}

function renderChat() {
  return render(<Chat orgId="org1" workspaceId="ws1" chatId={CHAT_ID} />);
}

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
function agentOn(id: string, providerId: string, modelId: string) {
  return {
    id,
    name: id,
    providerId,
    modelId,
  };
}

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
function renderWithAgent(agentId: string) {
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
}

describe("a Transcript summary", () => {
  // ADR-0041, issue #1716: the divider renders at the anchor of the summary the
  // Chat actually reads, and opens to its text; the composer meter reads "—"
  // until the next turn reports a reading taken through it.
  const turns = (): PlatypusUIMessage[] => [
    { id: "u1", role: "user", parts: [{ type: "text", text: "u1" }] },
    { id: "a1", role: "assistant", parts: [{ type: "text", text: "a1" }] },
    { id: "u2", role: "user", parts: [{ type: "text", text: "u2" }] },
    { id: "a2", role: "assistant", parts: [{ type: "text", text: "a2" }] },
    { id: "u3", role: "user", parts: [{ type: "text", text: "u3" }] },
    { id: "a3", role: "assistant", parts: [{ type: "text", text: "a3" }] },
  ];

  const summaryRow = (over: Record<string, unknown> = {}) => ({
    id: "sum-1",
    chatId: CHAT_ID,
    anchorId: "a1",
    coveredIds: ["u1", "a1"],
    text: "The condensed earlier conversation.",
    stats: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...over,
  });

  const renderWith = (summaries: unknown[], messages = turns()) => {
    harness.data.set("/agents", { results: [] });
    harness.data.set(`/chat/${CHAT_ID}`, {
      status: "succeeded",
      messages,
      tree: messages.map((message, i) => ({
        id: message.id,
        parentId: messages[i - 1]?.id ?? null,
      })),
      summaries,
    });
    harness.turn.messages = messages;
    return renderChat();
  };

  it("renders the divider at the anchor and expands to the summary text", async () => {
    renderWith([summaryRow()]);

    const divider = await screen.findByRole("button", {
      name: /Earlier messages were condensed/,
    });
    expect(divider).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.queryByText("The condensed earlier conversation."),
    ).not.toBeInTheDocument();

    fireEvent.click(divider);

    expect(divider).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByText("The condensed earlier conversation."),
    ).toBeInTheDocument();
    // Every message above the divider is still on screen.
    expect(screen.getByRole("button", { name: "Edit u1" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit a1" })).toBeInTheDocument();
  });

  it("does not render the divider for a summary a Delete made unusable", async () => {
    renderWith([summaryRow({ coveredIds: ["gone", "a1"] })]);

    // Wait for the transcript, then assert the absence.
    await screen.findByRole("button", { name: "Edit u1" });
    expect(
      screen.queryByRole("button", { name: /Earlier messages were condensed/ }),
    ).not.toBeInTheDocument();
  });

  it("shows the meter as — once a summary the last reading predates is in place", async () => {
    const messages = turns();
    messages[5] = {
      ...messages[5],
      metadata: { contextOccupancy: { inputTokens: 900, outputTokens: 50 } },
    };
    renderWith([summaryRow()], messages);

    expect(await screen.findByText("—")).toBeInTheDocument();
  });

  it("shows the status the turn streamed while it waited for a summary", async () => {
    harness.turn.status = "streaming";
    renderWith(
      [],
      [
        ...turns(),
        {
          id: "a4",
          role: "assistant",
          parts: [
            {
              type: "data-transcript-summary-status",
              data: { text: "Summarising earlier messages…" },
            },
          ],
        },
      ],
    );

    // The transcript's copy is `chat-message`'s own test's business; this stub
    // renders only the composer's.
    expect(
      await screen.findByText("Summarising earlier messages…"),
    ).toBeInTheDocument();
  });

  it("shows the meter once the last reading was taken through the summary", async () => {
    const messages = turns();
    messages[5] = {
      ...messages[5],
      metadata: {
        contextOccupancy: { inputTokens: 200, outputTokens: 50 },
        summaryId: "sum-1",
      },
    };
    renderWith([summaryRow()], messages);

    await screen.findByRole("button", { name: "Edit u1" });
    expect(screen.queryByText("—")).not.toBeInTheDocument();
  });
});

describe("composer tool row", () => {
  it("names the chat settings button in a Chat with no Agent", () => {
    harness.data.set("/providers", { results: [searchProvider] });
    harness.data.set("/agents", { results: [] });
    render(<Chat orgId="org1" workspaceId="ws1" chatId={CHAT_ID} />);

    expect(
      screen.getByRole("button", { name: "Settings" }),
    ).toBeInTheDocument();
  });
});

describe("the Context window hint", () => {
  it("points at Provider settings when no Context window is declared", () => {
    renderWithAgent("as");

    expect(screen.getByText(/No Context window set/)).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /Provider settings/ }),
    ).toHaveAttribute("href", "/org1/workspace/ws1/settings/providers");
  });

  it("is not shown when the model declares a Context window", () => {
    harness.data.set("/agents", { results: [] });
    renderChat();

    expect(screen.queryByText(/No Context window set/)).not.toBeInTheDocument();
  });
});

describe("an A2A Chat", () => {
  it("says which A2A client started it", () => {
    harness.data.set("/agents", { results: [] });
    harness.data.set(`/chat/${CHAT_ID}`, {
      status: "succeeded",
      messages: [],
      a2aClientName: "Telegram via Hermes",
    });
    render(<Chat orgId="org1" workspaceId="ws1" chatId={CHAT_ID} />);

    expect(
      screen.getByText("Over A2A from Telegram via Hermes"),
    ).toBeInTheDocument();
  });
});

describe("Upload to Sandbox", () => {
  const renderOn = ({
    toolSetIds = ["sandbox"],
    upload = true,
    agentId = "as",
  }: { toolSetIds?: string[]; upload?: boolean; agentId?: string } = {}) => {
    harness.data.set("/providers", { results: [searchProvider] });
    harness.data.set("/agents", {
      results: [{ ...agentOn("as", "ps", "ms"), toolSetIds }],
    });
    harness.data.set("/sandbox", {
      transfer: { upload, download: true },
    });
    return render(
      <Chat
        orgId="org1"
        workspaceId="ws1"
        chatId={CHAT_ID}
        initialAgentId={agentId}
      />,
    );
  };

  it("is offered for an Agent with the sandbox Tool set on a Sandbox that accepts uploads", () => {
    renderOn();
    expect(screen.getByText("Upload to Sandbox")).toBeInTheDocument();
  });

  it.each([
    ["an Agent without the sandbox Tool set", { toolSetIds: [] }],
    ["a backend that cannot upload", { upload: false }],
  ])("is hidden for %s", (_, shape) => {
    renderOn(shape);
    expect(screen.queryByText("Upload to Sandbox")).not.toBeInTheDocument();
  });

  it("is hidden when the Workspace has no Sandbox", () => {
    harness.data.set("/sandbox", null);
    harness.data.set("/providers", { results: [searchProvider] });
    harness.data.set("/agents", {
      results: [{ ...agentOn("as", "ps", "ms"), toolSetIds: ["sandbox"] }],
    });
    render(
      <Chat
        orgId="org1"
        workspaceId="ws1"
        chatId={CHAT_ID}
        initialAgentId="as"
      />,
    );
    expect(screen.queryByText("Upload to Sandbox")).not.toBeInTheDocument();
  });

  // The message goes only once its uploads land (ADR-0028), so the wait in
  // between reads as a sent turn, and a second Send is turned away out loud.
  it("shows Send busy while uploads run and refuses a second Send", async () => {
    const { fetchMock, resolve } = stubPendingSave();
    harness.sandboxFiles = [new File(["a,b"], "a.csv")];
    renderOn();
    const submit = screen.getByTestId("submit");

    fireEvent.click(submit);
    await waitFor(() =>
      expect(submit).toHaveAttribute("data-status", "submitted"),
    );
    expect(screen.getByRole("textbox")).toHaveAttribute(
      "data-status",
      "submitted",
    );

    fireEvent.click(submit);
    await waitFor(() => expect(harness.toastInfo).toHaveBeenCalled());
    expect(harness.stop).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolve();
    await waitFor(() => expect(harness.sendMessage).toHaveBeenCalledTimes(1));
    expect(submit).toHaveAttribute("data-status", "ready");
  });

  // The turn has not started, so Escape has nothing to stop (issue #1604).
  it("leaves Escape alone while uploads run", async () => {
    const { fetchMock } = stubPendingSave();
    harness.sandboxFiles = [new File(["a,b"], "a.csv")];
    renderOn();
    const submit = screen.getByTestId("submit");
    fireEvent.click(submit);
    await waitFor(() =>
      expect(submit).toHaveAttribute("data-status", "submitted"),
    );

    fireEvent.keyDown(document.body, { key: "Escape" });

    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/cancel")),
    ).toHaveLength(0);
    expect(harness.stop).not.toHaveBeenCalled();
  });

  it("returns Send to idle when an upload fails", async () => {
    stubRejectedSave("Sandbox unreachable", 500);
    harness.sandboxFiles = [new File(["a,b"], "a.csv")];
    renderOn();
    const submit = screen.getByTestId("submit");

    fireEvent.click(submit);
    await waitFor(() => expect(harness.toastError).toHaveBeenCalled());
    expect(submit).toHaveAttribute("data-status", "ready");
    expect(harness.sendMessage).not.toHaveBeenCalled();
  });
});

/** The search toggle's Globe control, present only when the model can search. */
function searchToggle() {
  return screen.queryByRole("button", { name: "Search" });
}
function searchIsOn() {
  return searchToggle()?.getAttribute("data-variant") === "default";
}

/**
 * Renders, then walks the local turn through a status sequence the way the chat
 * hook would. The sequence matters: whether a turn ever reached `streaming` is
 * what tells a dropped connection from a request the server refused, so a test
 * that jumped straight to `error` would be describing a different failure.
 */
function renderThrough(...statuses: ChatStatus[]) {
  const view = renderChat();
  for (const status of statuses) {
    harness.turn.status = status;
    if (status === "error") harness.turn.error = new Error("Failed to fetch");
    view.rerender(<Chat orgId="org1" workspaceId="ws1" chatId={CHAT_ID} />);
  }
  return view;
}

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
  harness.addToolApprovalResponse.mockReset();
  harness.stop.mockReset();
  harness.toastError.mockReset();
  harness.toastInfo.mockReset();
  harness.sandboxFiles = [];
  harness.chatMutate.mockReset();
  harness.chatMutate.mockResolvedValue(undefined);
  harness.agentsMutate.mockReset();
  harness.agentsMutate.mockResolvedValue(undefined);
  harness.chatMessageRenders = 0;
  harness.lastChatMessageProps = null;
});

describe("Chat detail read", () => {
  // Every other read keeps the throwing contract; the concession is per-key.
  // The Sandbox read has it too: a Workspace may have no Sandbox. The Chat row's
  // own read lives behind `useChatTranscript`; it is pinned there.
  it("leaves the other reads on the shared fetcher", () => {
    renderChat();

    const others = harness.swrCalls.filter(
      (c) => c.key !== CHAT_KEY && !String(c.key).endsWith("/sandbox"),
    );
    expect(others.length).toBeGreaterThan(0);
    for (const call of others) {
      expect(call.fetcher).not.toBe(optionalFetcher);
    }
  });
});

// A streamed reply arrives a chunk at a time; the Chat must not redo its
// per-render work for each one.
describe("streaming renders", () => {
  it("batches streamed chunks into at most one update per 50ms", () => {
    renderChat();

    expect(harness.chatOptions!.experimental_throttle).toBe(50);
  });

  it("keeps the same transport across re-renders", () => {
    const view = renderChat();
    const first = harness.chatOptions!.transport;

    view.rerender(<Chat orgId="org1" workspaceId="ws1" chatId={CHAT_ID} />);

    expect(harness.chatOptions!.transport).toBe(first);
  });

  // The body shaping is `lib/chat-transport.test.ts`'s business; what this can
  // see is that the Chat hands its transport the function that does it.
  it("shapes each turn's body with the server-owned Transcript request", () => {
    renderChat();

    expect(harness.chatOptions!.transport).toBeInstanceOf(DefaultChatTransport);
    expect(harness.chatOptions!.transport).toHaveProperty(
      "prepareSendMessagesRequest",
      prepareChatTurnRequest,
    );
  });
});

// Which surface an error selects. The reported symptom was a modal telling the
// user their turn had failed while the run was healthy and still going.
describe("routing a chat error", () => {
  const RECOVERING = /Connection interrupted/;

  it("shows an inline line and no modal when the run is still going", () => {
    harness.data.set(`/chat/${CHAT_ID}`, { status: "running", messages: [] });
    const { container } = renderThrough(...DROPPED);

    expect(container).toHaveTextContent(RECOVERING);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  // The run finished while the connection was gone, so there is nothing to
  // report and nothing to wait for — the snapshot already holds the answer.
  it("says nothing once the run has finished behind the drop", () => {
    harness.data.set(`/chat/${CHAT_ID}`, { status: "succeeded", messages: [] });
    const { container } = renderThrough(...DROPPED);

    expect(container).not.toHaveTextContent(RECOVERING);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("opens the modal for a run that reached a terminal failed status", () => {
    harness.data.set(`/chat/${CHAT_ID}`, { status: "failed", messages: [] });
    const { container } = renderThrough(...DROPPED);

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(container).not.toHaveTextContent(RECOVERING);
  });

  // Nothing streamed, so the server never took a run: a rejected attachment, a
  // refused submission. The user has to be told.
  it("opens the modal for a request that never established", () => {
    harness.data.set(`/chat/${CHAT_ID}`, { status: "succeeded", messages: [] });
    const { container } = renderThrough(...REFUSED);

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(container).not.toHaveTextContent(RECOVERING);
  });

  it("says nothing at all while a turn is healthy", () => {
    harness.data.set(`/chat/${CHAT_ID}`, { status: "running", messages: [] });
    const { container } = renderChat();

    expect(container).not.toHaveTextContent(RECOVERING);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  // Keyed on the error so the modal can be dismissed while the error persists;
  // a later, different error still reopens it.
  it("reopens for a second, different failure after being dismissed", () => {
    harness.data.set(`/chat/${CHAT_ID}`, { status: "failed", messages: [] });
    const view = renderThrough(...DROPPED);
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss error" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    harness.turn.error = new Error("a second failure");
    view.rerender(<Chat orgId="org1" workspaceId="ws1" chatId={CHAT_ID} />);

    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});

/**
 * Whether the turn's stream ever established, judged per turn. The belief is
 * `useChatTranscript`'s and is pinned there; what this sees is that a second
 * turn's refused request still opens the modal rather than being read as a
 * dropped connection to the first turn's stream.
 */
describe("turn establishment", () => {
  it("judges a second turn on its own stream, not an earlier turn's", () => {
    harness.data.set(`/chat/${CHAT_ID}`, { status: "succeeded", messages: [] });
    renderThrough("submitted", "streaming", "ready", "submitted", "error");

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

// The composer guard. The old predicate required the local status to be `ready`,
// which is the one reading a dropped stream never has.
describe("holding the composer", () => {
  it("holds it after a stream drops mid-run", () => {
    harness.data.set(`/chat/${CHAT_ID}`, { status: "running", messages: [] });
    renderThrough(...DROPPED);

    expect(screen.getByPlaceholderText("Run in progress…")).toBeDisabled();
    expect(screen.getByTestId("submit")).toHaveAttribute(
      "data-status",
      "streaming",
    );
  });

  it("holds it for a tab that arrived mid-run", () => {
    harness.data.set(`/chat/${CHAT_ID}`, { status: "running", messages: [] });
    renderChat();

    expect(screen.getByPlaceholderText("Run in progress…")).toBeDisabled();
  });

  // Once the run is over the composer comes back, and the submit button must
  // not keep a failure icon on it — the local status is still `error`.
  it("releases it once the run is over, with no failure on the button", () => {
    harness.data.set(`/chat/${CHAT_ID}`, { status: "succeeded", messages: [] });
    renderThrough(...DROPPED);

    expect(
      screen.getByPlaceholderText("What would you like to know?"),
    ).toBeEnabled();
    expect(screen.getByTestId("submit")).toHaveAttribute(
      "data-status",
      "ready",
    );
  });

  it("keeps the error reading for a turn that actually failed", () => {
    harness.data.set(`/chat/${CHAT_ID}`, { status: "failed", messages: [] });
    renderThrough(...DROPPED);

    expect(screen.getByTestId("submit")).toHaveAttribute(
      "data-status",
      "error",
    );
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
  const withAttachment = (): PlatypusUIMessage => ({
    id: "u1",
    role: "user",
    parts: [reportPdf, { type: "text", text: "What does this say?" }],
  });

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

    expect(screen.queryByTestId("editor")).not.toBeInTheDocument();
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

  // The turn's rows, and with them the tree that gives a new Alternative its
  // arrows, reach this tab only through the Chat read. A turn that ends inside
  // one poll interval leaves nothing else to re-read it.
  it.each(["ready", "error"] as const)(
    "re-reads the row when this tab's turn ends at %s",
    (end) => {
      harness.data.set(`/chat/${CHAT_ID}`, directRow(10));
      harness.turn.status = "streaming";
      const view = renderChat();
      expect(harness.chatMutate).not.toHaveBeenCalled();

      harness.turn.status = end;
      view.rerender(<Chat orgId="org1" workspaceId="ws1" chatId={CHAT_ID} />);

      expect(harness.chatMutate).toHaveBeenCalledTimes(1);
      expect(harness.chatMutate).toHaveBeenCalledWith();
    },
  );

  // Issue #1256: the last answer sends every answer, with the turn's body.
  it("answers an approval with the turn's body, sending once all are answered", () => {
    harness.data.set(`/chat/${CHAT_ID}`, directRow(10));
    harness.turn.messages = [message("u1", "q"), message("a1", "a")];
    renderChat();

    fireEvent.click(screen.getByRole("button", { name: "Approve a1" }));

    expect(harness.addToolApprovalResponse).toHaveBeenCalledWith({
      id: "ap1",
      approved: true,
      options: {
        body: expect.objectContaining({
          providerId: "p1",
          maxSteps: 10,
        }) as unknown,
      },
    });
    expect(harness.chatOptions!.sendAutomaticallyWhen).toBe(
      lastAssistantMessageIsCompleteWithApprovalResponses,
    );
  });

  it("offers an answer only on the Active leaf, and only while idle", () => {
    harness.data.set(`/chat/${CHAT_ID}`, directRow(10));
    harness.turn.messages = [message("u1", "q"), message("a1", "a")];
    const view = renderChat();
    expect(
      screen.queryByRole("button", { name: "Approve u1" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Approve a1" }),
    ).toBeInTheDocument();

    harness.turn.status = "streaming";
    view.rerender(<Chat orgId="org1" workspaceId="ws1" chatId={CHAT_ID} />);

    expect(
      screen.queryByRole("button", { name: "Approve a1" }),
    ).not.toBeInTheDocument();
  });

  it("does not re-read the row on a render with no turn ending", () => {
    harness.data.set(`/chat/${CHAT_ID}`, directRow(10));
    const view = renderChat();

    view.rerender(<Chat orgId="org1" workspaceId="ws1" chatId={CHAT_ID} />);

    expect(harness.chatMutate).not.toHaveBeenCalled();
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

    expect(
      screen.queryByRole("button", { name: "Regenerate a2" }),
    ).not.toBeInTheDocument();
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

    expect(
      screen.getByRole("button", { name: "Regenerate a2" }),
    ).toBeInTheDocument();
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
  it("refreshes the row after a composer send", async () => {
    harness.data.set(`/chat/${CHAT_ID}`, directRow(10));
    renderChat();

    fireEvent.click(screen.getByTestId("submit"));

    await waitFor(() => expect(harness.sendMessage).toHaveBeenCalled());
    expect(harness.sendMessage).toHaveBeenCalledWith(
      { text: "Hello", files: [] },
      { body: expect.objectContaining({ providerId: "p1" }) },
    );
    expect(harness.chatMutate).toHaveBeenCalledTimes(1);
  });
});

// Moving between Alternatives (#712): the switch itself is
// `useChatTranscript`'s, and is pinned in its own test. What this sees is that
// the Chat hands each message the position the hook worked out.
describe("switching between Alternatives", () => {
  const edited = ["u1", "a1", "u2b", "a2b"].map((id) => message(id, id));

  const showing = (held: PlatypusUIMessage[]) => {
    harness.data.set(`/chat/${CHAT_ID}`, alternativesRow(held, CHAT_ID));
    harness.turn.messages = held;
    harness.setMessages.mockImplementation((update) => {
      harness.turn.messages =
        typeof update === "function" ? update(harness.turn.messages) : update;
    });
    return renderChat();
  };

  // The switch itself — the local swap, one request at a time, the rollback —
  // is `useChatTranscript`'s and is pinned there. What this sees is that the
  // Chat hands each message the position the hook worked out.
  it("hands each message its position among its Alternatives", () => {
    showing(edited);

    expect(screen.getByText("u2b 2/3")).toBeInTheDocument();
    expect(screen.queryByText(/^a2b /)).not.toBeInTheDocument();
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
    fireEvent.click(screen.getByRole("button", { name: "Agent info" }));
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
      expect(screen.queryByText(/Read-only mode/)).not.toBeInTheDocument();
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

/**
 * Escape is the stop button's shortcut (issue #1604): the same `turn.cancel()`,
 * so the server-side run stops too, not just the local stream.
 */
describe("Escape", () => {
  const pressEscape = (target: Element = document.body, init = {}) =>
    fireEvent.keyDown(target, { key: "Escape", ...init });

  const cancelPosts = (fetchMock: ReturnType<typeof stubAcceptedSave>) =>
    fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/cancel"));

  it("stops a turn streaming in this tab", () => {
    const fetchMock = stubAcceptedSave();
    renderThrough("submitted", "streaming");

    pressEscape();

    expect(cancelPosts(fetchMock)).toHaveLength(1);
    expect(harness.stop).toHaveBeenCalledTimes(1);
  });

  it("stops a run held elsewhere, as the stop button does", () => {
    const fetchMock = stubAcceptedSave();
    harness.data.set(`/chat/${CHAT_ID}`, { status: "running", messages: [] });
    renderChat();
    expect(screen.getByPlaceholderText("Run in progress…")).toBeDisabled();

    pressEscape();

    expect(cancelPosts(fetchMock)).toHaveLength(1);
    expect(harness.stop).toHaveBeenCalledTimes(1);
  });

  it("does nothing with no turn in flight", () => {
    const fetchMock = stubAcceptedSave();
    renderChat();

    pressEscape();

    expect(cancelPosts(fetchMock)).toHaveLength(0);
    expect(harness.stop).not.toHaveBeenCalled();
  });

  it("yields to a handler that already claimed the press", () => {
    const fetchMock = stubAcceptedSave();
    renderThrough("submitted", "streaming");
    const claim = (event: KeyboardEvent) => event.preventDefault();
    document.addEventListener("keydown", claim, { capture: true });

    pressEscape();
    document.removeEventListener("keydown", claim, { capture: true });

    expect(cancelPosts(fetchMock)).toHaveLength(0);
    expect(harness.stop).not.toHaveBeenCalled();
  });

  it.each(["dialog", "alertdialog", "menu", "listbox"])(
    "yields to an open %s, which Escape closes",
    (role) => {
      const fetchMock = stubAcceptedSave();
      renderThrough("submitted", "streaming");
      const surface = document.createElement("div");
      surface.setAttribute("role", role);
      const inner = document.createElement("input");
      surface.append(inner);
      document.body.append(surface);

      pressEscape(inner);
      surface.remove();

      expect(cancelPosts(fetchMock)).toHaveLength(0);
      expect(harness.stop).not.toHaveBeenCalled();
    },
  );

  it("yields to an open message editor", () => {
    const fetchMock = stubAcceptedSave();
    harness.turn.messages = [message("u1", "q")];
    renderThrough("submitted", "streaming");
    fireEvent.click(screen.getByRole("button", { name: "Edit u1" }));

    pressEscape();

    expect(cancelPosts(fetchMock)).toHaveLength(0);
    expect(harness.stop).not.toHaveBeenCalled();
  });

  it("ignores a press made while composing IME input", () => {
    const fetchMock = stubAcceptedSave();
    renderThrough("submitted", "streaming");

    pressEscape(document.body, { isComposing: true });

    expect(cancelPosts(fetchMock)).toHaveLength(0);
  });

  it("sends one cancel while the key is held down", () => {
    const fetchMock = stubAcceptedSave();
    renderThrough("submitted", "streaming");

    pressEscape();
    pressEscape(document.body, { repeat: true });
    pressEscape(document.body, { repeat: true });

    expect(cancelPosts(fetchMock)).toHaveLength(1);
    expect(harness.stop).toHaveBeenCalledTimes(1);
  });

  it("is named on the stop button only while a turn is in flight", () => {
    const view = renderChat();
    expect(screen.getByTestId("submit")).not.toHaveAccessibleName("Stop (Esc)");

    harness.turn.status = "streaming";
    view.rerender(<Chat orgId="org1" workspaceId="ws1" chatId={CHAT_ID} />);

    expect(screen.getByTestId("submit")).toHaveAccessibleName("Stop (Esc)");
  });
});
