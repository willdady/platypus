import { describe, it, expect, beforeEach, vi } from "vitest";
import { memo } from "react";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  within,
} from "@testing-library/react";
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
import type { ArtifactOpenTarget } from "./artifact-tool-card";

type SwrCall = {
  key: string;
  fetcher: unknown;
  config: Record<string, unknown> | undefined;
};

type TurnOptions = { body: unknown };

function turnOptions(body: unknown): TurnOptions {
  return { body };
}

const { harness } = vi.hoisted(() => ({
  harness: {
    swrCalls: [] as SwrCall[],
    data: new Map<string, unknown>(),
    responses: new Map<string, unknown>(),
    auth: { user: { id: "u1" }, ownsWorkspace: true, isAuthLoading: false },
    turn: {
      status: "ready",
      error: undefined as Error | undefined,
      messages: [] as PlatypusUIMessage[],
    },
    setMessages:
      vi.fn<
        (
          update:
            | PlatypusUIMessage[]
            | ((held: PlatypusUIMessage[]) => PlatypusUIMessage[]),
        ) => void
      >(),
    sendMessage: vi.fn<(message: unknown, options: TurnOptions) => void>(),
    regenerate:
      vi.fn<(options: TurnOptions & { messageId?: string }) => void>(),
    addToolApprovalResponse:
      vi.fn<
        (options: {
          id: string;
          approved: boolean;
          options: TurnOptions;
        }) => void
      >(),
    stop: vi.fn(),
    toastError: vi.fn(),
    toastInfo: vi.fn(),
    sandboxFiles: [] as File[],
    chatMutate: vi.fn(),
    agentsMutate: vi.fn(),
    chatOptions: undefined as
      | undefined
      | {
          transport: DefaultChatTransport<PlatypusUIMessage>;
          experimental_throttle?: number;
          sendAutomaticallyWhen?: unknown;
        },
  },
}));

let chatMessageRenders = 0;
let chatMessageRendersById: Record<string, number> = {};
function countChatMessageRender(messageId: string) {
  chatMessageRenders += 1;
  chatMessageRendersById[messageId] =
    (chatMessageRendersById[messageId] ?? 0) + 1;
}

let lastChatMessageProps: null | {
  onMessageDelete: (messageId: string) => void;
  onRegenerate?: (messageId: string) => void;
  onSwitchAlternative: (fromId: string, toId: string) => void;
  staleToolCallIds?: ReadonlySet<string>;
} = null;
function recordChatMessageProps(
  props: NonNullable<typeof lastChatMessageProps>,
) {
  lastChatMessageProps = props;
}

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
vi.mock("@/lib/clipboard", () => ({ copyWithToast: async () => true }));

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

vi.mock("./chat-message", () => ({
  ChatMessage: memo(function ChatMessageStub({
    message,
    editor,
    onEditStart,
    onMessageDelete,
    onRegenerate,
    alternatives,
    onSwitchAlternative,
    onCopyMessage,
    staleToolCallIds,
    onApprovalResponse,
    onOpenArtifact,
  }: {
    message: PlatypusUIMessage;
    editor?: React.ReactNode;
    onEditStart: (messageId: string) => void;
    onMessageDelete: (messageId: string) => void;
    onRegenerate?: (messageId: string) => void;
    alternatives?: AlternativePosition;
    onSwitchAlternative: (fromId: string, toId: string) => void;
    onCopyMessage: (content: string, messageId: string) => void;
    staleToolCallIds?: ReadonlySet<string>;
    onApprovalResponse?: (approvalId: string, approved: boolean) => void;
    onOpenArtifact?: (target: ArtifactOpenTarget) => void;
  }) {
    countChatMessageRender(message.id);
    recordChatMessageProps({
      onMessageDelete,
      onRegenerate,
      onSwitchAlternative,
      staleToolCallIds,
    });
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
            <button
              type="button"
              onClick={() => onCopyMessage(`text of ${message.id}`, message.id)}
            >
              Copy {message.id}
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
            {onOpenArtifact && (
              <>
                <button
                  type="button"
                  onClick={() =>
                    onOpenArtifact({ id: "artifact-1", version: 1 })
                  }
                >
                  Open artifact {message.id}
                </button>
                <button
                  type="button"
                  onClick={() =>
                    onOpenArtifact({ toolCallId: STREAMING_TOOL_CALL_ID })
                  }
                >
                  Open streaming artifact {message.id}
                </button>
              </>
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
  }),
}));

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
vi.mock("./artifact-viewer", () => ({
  ArtifactViewer: ({
    artifactId,
    version,
    live,
    onClose,
  }: {
    artifactId?: string;
    version?: number;
    live?: { status: string; content: string };
    onClose?: () => void;
  }) => (
    <div>
      Artifact panel {artifactId ?? "streaming"} v{version}
      {live && (
        <div>
          Live {live.status} {live.content}
        </div>
      )}
      {onClose && (
        <button type="button" onClick={onClose}>
          Close artifact panel
        </button>
      )}
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
const STREAMING_TOOL_CALL_ID = "call-1";
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

describe("Chat Artifact panel", () => {
  function artifactCall(over: Record<string, unknown>): PlatypusUIMessage {
    return {
      id: "a2",
      role: "assistant",
      parts: [
        {
          type: "tool-createArtifact",
          toolCallId: STREAMING_TOOL_CALL_ID,
          input: {
            title: "Release notes",
            type: "markdown",
            content: "# Half",
          },
          ...over,
        },
      ],
    } as unknown as PlatypusUIMessage;
  }

  it("keeps the centred Chat column while the panel is closed", () => {
    harness.turn.messages = [message("a1", "Hello")];
    renderChat();

    const columns = screen.getAllByTestId("chat-column");
    expect(columns.length).toBeGreaterThan(0);
    for (const column of columns) {
      expect(column).toHaveClass("xl:w-4/5");
    }
  });

  it("fills the Chat column while the panel is open", () => {
    harness.turn.messages = [message("a1", "Hello")];
    renderChat();

    fireEvent.click(screen.getByRole("button", { name: "Open artifact a1" }));

    expect(
      screen.getByText("Artifact panel artifact-1 v1"),
    ).toBeInTheDocument();
    const columns = screen.getAllByTestId("chat-column");
    expect(columns.length).toBeGreaterThan(0);
    for (const column of columns) {
      expect(column).not.toHaveClass("max-w-4xl");
    }
  });

  it("opens the viewer beside the transcript and closes it", () => {
    harness.turn.messages = [message("a1", "Hello")];
    renderChat();

    fireEvent.click(screen.getByRole("button", { name: "Open artifact a1" }));

    expect(
      screen.getByText("Artifact panel artifact-1 v1"),
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Close artifact panel" }),
    );

    expect(
      screen.queryByText("Artifact panel artifact-1 v1"),
    ).not.toBeInTheDocument();
  });

  it("keeps the composer's draft when the panel opens and closes", () => {
    harness.turn.messages = [message("a1", "Hello")];
    renderChat();
    const currentComposer = () =>
      screen.getByPlaceholderText<HTMLTextAreaElement>(
        "What would you like to know?",
      );

    fireEvent.change(currentComposer(), {
      target: { value: "half a message" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Open artifact a1" }));
    expect(currentComposer().value).toBe("half a message");

    fireEvent.click(
      screen.getByRole("button", { name: "Close artifact panel" }),
    );
    expect(currentComposer().value).toBe("half a message");
  });

  it("keeps the open Artifact in the URL, so a refresh reopens it", () => {
    harness.turn.messages = [message("a1", "Hello")];
    const first = renderChat();

    fireEvent.click(screen.getByRole("button", { name: "Open artifact a1" }));
    expect(window.location.search).toBe("?artifact=artifact-1%3A1");

    first.unmount();
    renderChat();
    expect(
      screen.getByText("Artifact panel artifact-1 v1"),
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Close artifact panel" }),
    );
    expect(window.location.search).toBe("");
  });

  it("opens a Card whose content is still streaming and follows the call to the stored version", () => {
    harness.turn.messages = [artifactCall({ state: "input-streaming" })];
    const view = renderChat();

    fireEvent.click(
      screen.getByRole("button", { name: "Open streaming artifact a2" }),
    );

    expect(screen.getByText(/Artifact panel streaming/)).toBeInTheDocument();
    expect(screen.getByText("Live streaming # Half")).toBeInTheDocument();

    harness.turn.messages = [
      artifactCall({
        state: "output-available",
        output: { id: "artifact-1", title: "Release notes", version: 1 },
      }),
    ];
    view.rerender(<Chat orgId="org1" workspaceId="ws1" chatId={CHAT_ID} />);

    expect(
      screen.getByText("Artifact panel artifact-1 v1"),
    ).toBeInTheDocument();
    expect(screen.getByText("Live streaming # Half")).toBeInTheDocument();
  });

  it("opens a failed call with its content marked as failed, not stored", () => {
    harness.turn.messages = [
      artifactCall({ state: "output-error", errorText: "Too big" }),
    ];
    renderChat();

    fireEvent.click(
      screen.getByRole("button", { name: "Open streaming artifact a2" }),
    );

    expect(screen.getByText("Live failed # Half")).toBeInTheDocument();
    expect(
      screen.queryByText(/Artifact panel artifact-1/),
    ).not.toBeInTheDocument();
  });

  it("opens a rejected call with its content marked as failed, not stored", () => {
    harness.turn.messages = [
      artifactCall({
        state: "approval-responded",
        approval: { id: "approval-1", approved: false },
      }),
    ];
    renderChat();

    fireEvent.click(
      screen.getByRole("button", { name: "Open streaming artifact a2" }),
    );

    expect(screen.getByText("Live failed # Half")).toBeInTheDocument();
    expect(
      screen.queryByText(/Artifact panel artifact-1/),
    ).not.toBeInTheDocument();
  });
});

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
    toolSetIds: [],
    skillIds: [],
    subAgentIds: [],
  };
}

const searchAgents = [
  agentOn("as", "ps", "ms"),
  agentOn("as2", "ps", "ms"),
  agentOn("ap", "pp", "mp"),
];

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
      name: /Older messages were summarised/,
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
    expect(screen.getByRole("button", { name: "Edit u1" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit a1" })).toBeInTheDocument();
  });

  it("does not render the divider for a summary a Delete made unusable", async () => {
    renderWith([summaryRow({ coveredIds: ["gone", "a1"] })]);

    await screen.findByRole("button", { name: "Edit u1" });
    expect(
      screen.queryByRole("button", { name: /Older messages were summarised/ }),
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

function searchToggle() {
  return screen.queryByRole("button", { name: "Search" });
}
function searchIsOn() {
  return searchToggle()?.getAttribute("data-variant") === "default";
}

function renderThrough(...statuses: ChatStatus[]) {
  const view = renderChat();
  for (const status of statuses) {
    harness.turn.status = status;
    if (status === "error") harness.turn.error = new Error("Failed to fetch");
    view.rerender(<Chat orgId="org1" workspaceId="ws1" chatId={CHAT_ID} />);
  }
  return view;
}

const DROPPED: ChatStatus[] = ["submitted", "streaming", "error"];

const REFUSED: ChatStatus[] = ["submitted", "error"];

beforeEach(() => {
  window.history.replaceState(null, "", "/");
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
  chatMessageRenders = 0;
  chatMessageRendersById = {};
  lastChatMessageProps = null;
});

describe("Chat detail read", () => {
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

  it("shapes each turn's body with the server-owned Transcript request", () => {
    renderChat();

    expect(harness.chatOptions!.transport).toBeInstanceOf(DefaultChatTransport);
    expect(harness.chatOptions!.transport).toHaveProperty(
      "prepareSendMessagesRequest",
      prepareChatTurnRequest,
    );
  });
});

describe("routing a chat error", () => {
  const RECOVERING = /Connection interrupted/;

  it("shows an inline line and no modal when the run is still going", () => {
    harness.data.set(`/chat/${CHAT_ID}`, { status: "running", messages: [] });
    renderThrough(...DROPPED);

    expect(screen.getByText(RECOVERING)).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("says nothing once the run has finished behind the drop", () => {
    harness.data.set(`/chat/${CHAT_ID}`, { status: "succeeded", messages: [] });
    renderThrough(...DROPPED);

    expect(screen.queryByText(RECOVERING)).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("opens the modal for a run that reached a terminal failed status", () => {
    harness.data.set(`/chat/${CHAT_ID}`, { status: "failed", messages: [] });
    renderThrough(...DROPPED);

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.queryByText(RECOVERING)).not.toBeInTheDocument();
  });

  it("opens the modal for a request that never established", () => {
    harness.data.set(`/chat/${CHAT_ID}`, { status: "succeeded", messages: [] });
    renderThrough(...REFUSED);

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.queryByText(RECOVERING)).not.toBeInTheDocument();
  });

  it("says nothing at all while a turn is healthy", () => {
    harness.data.set(`/chat/${CHAT_ID}`, { status: "running", messages: [] });
    renderChat();

    expect(screen.queryByText(RECOVERING)).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

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

describe("turn establishment", () => {
  it("judges a second turn on its own stream, not an earlier turn's", () => {
    harness.data.set(`/chat/${CHAT_ID}`, { status: "succeeded", messages: [] });
    renderThrough("submitted", "streaming", "ready", "submitted", "error");

    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});

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

    view.rerender(
      <Chat
        orgId="org1"
        workspaceId="ws1"
        chatId={CHAT_ID}
        initialAgentId="ap"
      />,
    );
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
      turnOptions(expect.objectContaining({ providerId: "p1" })),
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

    expect(harness.sendMessage).toHaveBeenCalledWith(
      expect.anything(),
      turnOptions(expect.objectContaining({ parentId: "a1" })),
    );
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
      ...turnOptions(
        expect.objectContaining({ providerId: "p1", maxSteps: 10 }),
      ),
      messageId: "a1",
    });
    expect(harness.chatMutate).toHaveBeenCalledTimes(1);
  });

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

  it("answers an approval with the turn's body, sending once all are answered", () => {
    harness.data.set(`/chat/${CHAT_ID}`, directRow(10));
    harness.turn.messages = [message("u1", "q"), message("a1", "a")];
    renderChat();

    fireEvent.click(screen.getByRole("button", { name: "Approve a1" }));

    expect(harness.addToolApprovalResponse).toHaveBeenCalledWith({
      id: "ap1",
      approved: true,
      options: turnOptions(
        expect.objectContaining({
          providerId: "p1",
          maxSteps: 10,
        }),
      ),
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

  it("refreshes the row after a composer send", async () => {
    harness.data.set(`/chat/${CHAT_ID}`, directRow(10));
    renderChat();

    fireEvent.click(screen.getByTestId("submit"));

    await waitFor(() => expect(harness.sendMessage).toHaveBeenCalled());
    expect(harness.sendMessage).toHaveBeenCalledWith(
      { text: "Hello", files: [] },
      turnOptions(expect.objectContaining({ providerId: "p1" })),
    );
    expect(harness.chatMutate).toHaveBeenCalledTimes(1);
  });
});

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

  it("hands each message its position among its Alternatives", () => {
    showing(edited);

    expect(screen.getByText("u2b 2/3")).toBeInTheDocument();
    expect(screen.queryByText(/^a2b /)).not.toBeInTheDocument();
  });
});

describe("transcript stability", () => {
  it("keeps the stale tool-call set and the callbacks stable across renders", () => {
    harness.turn.messages = [message("u1", "q"), message("a1", "a")];
    const view = renderChat();
    const first = lastChatMessageProps!;

    view.rerender(<Chat orgId="org1" workspaceId="ws1" chatId={CHAT_ID} />);

    expect(lastChatMessageProps!.onMessageDelete).toBe(first.onMessageDelete);
    expect(lastChatMessageProps!.onRegenerate).toBe(first.onRegenerate);
    expect(lastChatMessageProps!.onSwitchAlternative).toBe(
      first.onSwitchAlternative,
    );
    expect(lastChatMessageProps!.staleToolCallIds).toBe(first.staleToolCallIds);
  });

  it("does not re-render the transcript while the composer is typed into", () => {
    harness.turn.messages = [message("u1", "q"), message("a1", "a")];
    renderChat();
    const before = chatMessageRenders;

    fireEvent.change(
      screen.getByPlaceholderText("What would you like to know?"),
      { target: { value: "hello" } },
    );

    expect(chatMessageRenders).toBe(before);
  });

  it("re-renders only the copied message and not the rest of the transcript", async () => {
    harness.turn.messages = [
      message("u1", "q"),
      message("a1", "a"),
      message("a2", "b"),
    ];
    renderChat();
    chatMessageRendersById = {};

    fireEvent.click(screen.getByRole("button", { name: "Copy a1" }));

    await waitFor(() => {
      expect(chatMessageRendersById.a1).toBe(1);
    });

    expect(chatMessageRendersById.u1).toBeUndefined();
    expect(chatMessageRendersById.a2).toBeUndefined();
  });

  it("keeps the cleared tool-call set stable while a reply streams", () => {
    harness.data.set(`/chat/${CHAT_ID}`, {
      id: CHAT_ID,
      status: "running",
      providerId: "p1",
      modelId: "m1",
      messages: [],
    });
    const toolResults = Array.from({ length: 10 }, (_, index) => index).map(
      (index) =>
        ({
          id: `a-t${index}`,
          role: "assistant",
          parts: [
            {
              type: "tool-read_url",
              toolCallId: `t${index}`,
              state: "output-available",
              input: {},
              output: "x".repeat(5_000),
            },
          ],
          metadata: {
            readOnlyToolNames: ["read_url"],
            contextOccupancy: { inputTokens: 950, outputTokens: 0 },
          },
        }) as unknown as PlatypusUIMessage,
    );
    harness.turn.messages = [...toolResults, message("a-last", "an answer")];
    const view = renderChat();
    const first = lastChatMessageProps!.staleToolCallIds;
    expect(first?.size).toBe(4);

    harness.turn.messages = [
      ...toolResults,
      message("a-last", "an answer, still streaming"),
    ];
    view.rerender(<Chat orgId="org1" workspaceId="ws1" chatId={CHAT_ID} />);

    expect(lastChatMessageProps!.staleToolCallIds).toBe(first);
  });
});

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

  it("swallows a failed re-read", async () => {
    harness.agentsMutate.mockRejectedValue(new Error("offline"));
    renderWithAgent("as");

    expect(() => openInfoDialog()).not.toThrow();
    await Promise.resolve();
  });
});

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

describe("loading", () => {
  const PROVIDERS_KEY =
    "http://test/organizations/org1/workspaces/ws1/providers";
  const AGENTS_KEY = "http://test/organizations/org1/workspaces/ws1/agents";
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

  it("keeps the skeleton's centred column while an Artifact is open", () => {
    rowInFlight();
    window.history.replaceState(null, "", "?artifact=artifact-1%3A1");

    renderChat();

    expect(loadingSkeleton()).toBeInTheDocument();
    const columns = screen.getAllByTestId("chat-column");
    expect(columns.length).toBeGreaterThan(0);
    for (const column of columns) {
      expect(column).toHaveClass("xl:w-4/5");
    }
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

  it("shows the agents read failure instead of a picker that never resolves", () => {
    harness.responses.set(AGENTS_KEY, {
      data: undefined,
      error: new Error("500"),
      isLoading: false,
      mutate: harness.agentsMutate,
    });
    harness.data.set(`/chat/${CHAT_ID}`, {
      status: "succeeded",
      messages: [],
      agentId: "a1",
    });

    renderChat();

    expect(screen.getByText(/Failed to load agents/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
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

      expect(
        within(
          screen.getByRole("status", { name: "Loading chat" }),
        ).getByTestId("composer-skeleton"),
      ).toBeInTheDocument();
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
