"use client";

import { TurnAnnouncer } from "./turn-announcer";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import {
  PromptInputButton,
  PromptInputSubmit,
  type PromptInputMessage,
} from "@/components/ai-elements/prompt-input";
import { useChat } from "@ai-sdk/react";
import {
  DefaultChatTransport,
  lastAssistantMessageIsCompleteWithApprovalResponses,
} from "ai";
import { GlobeIcon, Info, Settings2 } from "lucide-react";
import { AnimatePresence } from "motion/react";
import { useEffect, useCallback, useMemo, useState } from "react";
import type { Provider, Agent, ToolSet, Skill } from "@platypus/schemas";
import {
  BUILT_IN_CHAT_COMMANDS,
  isBuiltInChatCommandName,
  nextTurnOccupancy,
  type Sandbox,
  UNTITLED_CHAT_TITLE,
  type PlatypusUIMessage,
} from "@platypus/schemas";
import { cn, joinUrl, optionalFetcher } from "@/lib/utils";
import { workspaceRoutes } from "@/lib/routes";
import { isTurnInFlight, runMayBeLive } from "@/lib/chat-recovery";
import { scopedPath, scopedUrl } from "@/lib/api-write";
import { useSandboxUploads } from "@/hooks/use-sandbox-uploads";
import { useScopedSWR } from "@/hooks/use-scoped-swr";
import { useScopedList } from "@/hooks/use-scoped-list";
import { useResetOnChange } from "@/hooks/use-reset-on-change";
import { useChatSettings } from "@/hooks/use-chat-settings";
import { useModelSelection } from "@/hooks/use-model-selection";
import { useChatTranscript } from "@/hooks/use-chat-transcript";
import { prepareChatTurnRequest } from "@/lib/chat-transport";
import { resolveModel } from "@/lib/resolve-model";
import {
  clearedInputToolCallIds,
  clearedToolCallIds,
} from "@/lib/tool-result-clearing";
import {
  appliedTranscriptSummary,
  occupancyIsStaleAfterSummary,
  summarisingStatusOf,
} from "@/lib/chat-summary";
import { TranscriptSummaryDivider } from "./transcript-summary-divider";
import { TurnStatus } from "./turn-status";
import { useStableSet } from "@/hooks/use-stable-set";
import { useTimeout } from "@/hooks/use-timeout";
import { useStreamingFavicon } from "@/hooks/use-streaming-favicon";
import {
  ContextMeter,
  ContextMeterEntrance,
  ContextWindowHint,
} from "./context-meter";
import { useMessageEditing } from "@/hooks/use-message-editing";
import { useChatTurn } from "@/hooks/use-chat-turn";
import { Dialog, DialogTrigger } from "./ui/dialog";
import { useAuth, useBackendUrl } from "@/components/auth-provider";
import { canSendChatMessages } from "@/lib/authorization";
import { NoProvidersEmptyState } from "./no-providers-empty-state";
import { AgentInfoDialog } from "./agent-info-dialog";
import { ChatSettingsDialog } from "./chat-settings-dialog";
import { ChatErrorDialog } from "./chat-error-dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ChatMessage } from "./chat-message";
import { MessageEditor } from "./message-editor";
import { ChatReconnectingNotice } from "./chat-reconnecting-notice";
import { toast } from "sonner";
import { copyWithToast } from "@/lib/clipboard";
import { ChatComposer } from "./chat-composer";
import { ChatSkeleton } from "./chat-skeleton";
import { ListError } from "./list-state";
import type { ModelSelection } from "./composer";
import {
  builtInCommandOf,
  skillsForAgent,
  type SlashCommand,
} from "@/lib/slash-commands";

/** Open surfaces that close on Escape, so a press inside one is theirs. */
const ESCAPE_OWNERS =
  '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]';

/** The status line a `/compact` shows while its summary is being taken. */
const COMPACTING_STATUS = "Summarising the conversation…";

/**
 * Where the composer's context meter — or the hint that stands in for it when
 * no Context window is declared — sits in the footer. Narrow screens give it a
 * row of its own by bleeding back over the footer's padding; wide ones keep it
 * in source order with `mr-auto` eating the free space.
 */
const CONTEXT_FOOTER_PLACEMENT =
  "order-last -mx-3 w-[calc(100%+1.5rem)] sm:order-none sm:mx-0 sm:mr-auto sm:w-auto";

/** The tinted band either context element wears on a narrow screen. */
const CONTEXT_FOOTER_BAND =
  "mt-1.5 rounded-b-md bg-foreground/5 px-3 py-1.5 sm:mt-0 sm:rounded-none sm:bg-transparent sm:p-0";

export function Chat({
  orgId,
  workspaceId,
  chatId,
  initialAgentId,
}: {
  orgId: string;
  workspaceId: string;
  chatId: string;
  initialAgentId?: string;
}) {
  const { ownsWorkspace, isAuthLoading } = useAuth();
  const canSendMessages = canSendChatMessages(ownsWorkspace);
  const backendUrl = useBackendUrl();
  const scope = useMemo(() => ({ orgId, workspaceId }), [orgId, workspaceId]);
  const chatUrl = joinUrl(
    backendUrl || "",
    `${scopedPath("chat", scope)}/${chatId}`,
  );

  // Fetch providers
  const {
    data: providersData,
    results: providers,
    error: providersError,
    isLoading,
    mutate: mutateProviders,
  } = useScopedList<Provider>("providers", scope);

  // Fetch agents
  const {
    data: agentsData,
    results: agents,
    mutate: mutateAgents,
  } = useScopedList<Agent>("agents", scope);

  // The model-selection ladder is the one reader that needs "the list has not
  // landed yet" apart from "this workspace has no Agents" (issue #799), so it
  // takes the undefined-until-loaded value; everything else reads the plain
  // list.
  const agentsIfLoaded = agentsData?.results;

  const { results: toolSets } = useScopedList<ToolSet>("tools", scope);

  // The Workspace's Sandbox, for whether the composer offers Upload to Sandbox.
  const { data: sandbox } = useScopedSWR<Sandbox | null>("sandbox", scope, {
    fetcher: optionalFetcher,
  });
  const sandboxUploads = useSandboxUploads(
    scopedUrl(backendUrl || "", "sandbox/file", scope),
  );

  // Fetch skills
  const { results: skills } = useScopedList<Skill>("skills", scope);

  // The per-turn body rides each call (`useChatTurn` builds it) and wins the
  // SDK's shallow merge over this one, so the transport carries only what
  // never changes for the Chat (issue #971). Built once per Workspace, not on
  // every render — which, while a reply streams, is every chunk.
  const transport = useMemo(
    () =>
      new DefaultChatTransport<PlatypusUIMessage>({
        api: scopedUrl(backendUrl || "", "chat", scope),
        body: { orgId, workspaceId },
        credentials: "include",
        // The server owns the Transcript (ADR-0026); `prepareChatTurnRequest`
        // shapes each turn's body. See `lib/chat-transport.ts`.
        prepareSendMessagesRequest: prepareChatTurnRequest,
      }),
    [backendUrl, orgId, workspaceId, scope],
  );

  const {
    messages,
    setMessages,
    sendMessage,
    status,
    regenerate,
    addToolApprovalResponse,
    error,
    stop,
  } = useChat<PlatypusUIMessage>({
    id: chatId,
    transport,
    // The answer to a reply's last waiting approval sends them all.
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
    // Streamed chunks reach the screen at most once per 50ms, rather than one
    // render of the whole Chat per chunk.
    experimental_throttle: 50,
  });

  // The server-owned Transcript's client side: the row's read and poll,
  // monotonic hydration, the switch between Alternatives, the tree the
  // transcript renders, and the run belief (issue #648, ADR-0026).
  const {
    chatData,
    isChatLoading,
    refreshChat,
    runBelief,
    errorTreatment,
    runHeldElsewhere,
    effectiveStatus,
    parentOf,
    positions,
    isRegenerable,
    switchAlternative,
    deleteMessage,
    compact,
    isTranscriptPending,
  } = useChatTranscript({
    scope,
    chatId,
    chatUrl,
    messages,
    setMessages,
    status,
    error,
  });
  useStreamingFavicon(runMayBeLive(runBelief));

  // Custom hooks for state management (must be called before any conditional returns)
  const { selection, isResolved, substitution, handleModelChange } =
    useModelSelection({
      chatData: chatData ?? undefined,
      providers,
      agents: agentsIfLoaded,
      // SWR reports a key's first mount as loading even when the cache already
      // holds a value: a row, or the `null` the index route seeds for a new Chat.
      isChatLoading: isChatLoading && chatData === undefined,
      workspaceId,
      initialAgentId,
    });
  const { settings, updateSettings } = useChatSettings(
    chatData ?? undefined,
    selection.agentId,
  );

  // The Chat's own UI state, none of which any other surface shares.
  const [isSettingsDialogOpen, setIsSettingsDialogOpen] = useState(false);
  const [isAgentInfoDialogOpen, setIsAgentInfoDialogOpen] = useState(false);
  const [showErrorDialog, setShowErrorDialog] = useState(false);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const scheduleCopiedReset = useTimeout();

  // Show the error dialog when a new error arrives from useChat. Keyed on the
  // error so the user can still dismiss the dialog while the error persists,
  // and only a `failure` opens it: a dropped connection to a run that is still
  // going gets an inline line instead, because the turn has not failed and the
  // answer keeps filling in on its own (issue #648).
  useResetOnChange(error, () => {
    if (error && errorTreatment === "failure") {
      setShowErrorDialog(true);
    }
  });

  // Extract values from hooks for easier access
  const { agentId, modelId, providerId } = selection;

  const selectedAgent = useMemo(
    () => (agentId ? (agents.find((a) => a.id === agentId) ?? null) : null),
    [agentId, agents],
  );

  // What the slash-command picker offers — see `skillsForAgent` for why the
  // list is the Agent's unfiltered assignment.
  const agentSkills = useMemo(
    () => skillsForAgent(skills, selectedAgent?.skillIds),
    [selectedAgent, skills],
  );

  // One entry point for "what model will this Chat turn use, and what can it
  // do?" — replaces separately resolving the provider, the concrete model id,
  // passthrough file types, context window and search capability by hand.
  // `null` means nothing resolves yet: no selection made, or the selected
  // Agent/Provider/model reference no longer exists.
  const resolvedModel = resolveModel({
    providers,
    agents,
    selection: { agentId, modelId, providerId },
  });

  // The window the resolved model declares, if any. Without one the composer
  // cannot draw a meter, so it shows the hint instead (issue #1728).
  const contextWindow = resolvedModel?.contextWindow;

  // Where the window is declared: the Workspace's Provider list, reachable by
  // any reader who can send here. A Shared Provider is edited from its menu on
  // that list and opens on the Organization surface (ADR-0007).
  const contextWindowHref = workspaceRoutes(orgId, workspaceId).settings
    .providers;
  // What the model picker on both surfaces is configured with (issue #724).
  const modelSelection: ModelSelection = {
    agents,
    providers,
    agentId,
    modelId,
    providerId,
    isResolved,
    substitution,
    onModelChange: handleModelChange,
    maxOutputTokens: resolvedModel?.maxOutputTokens,
  };
  const [search, setSearch] = useState(false);
  // A `/compact` waiting on its summary; the composer holds until it lands.
  const [compacting, setCompacting] = useState(false);

  // The Chat search toggle's one invariant (#624): search may not be on when
  // the resolved selection cannot search. Keyed on `canSearch` itself — not on
  // the Agent/Provider/model identity — so switching between two selections
  // that can both search leaves the toggle exactly as the User set it. The
  // invariant only ever forces the toggle off, never on, and does nothing while
  // resolution is unknown (`resolvedModel === null`), so a brief
  // loading/revalidation gap can't silently discard a chosen setting.
  useResetOnChange(
    resolvedModel === null ? null : resolvedModel.canSearch,
    () => {
      if (resolvedModel && !resolvedModel.canSearch) setSearch(false);
    },
  );

  // An Agent holding the agent-management tools can rewrite its own row
  // mid-chat, and nothing else invalidates this read: the turn writes on the
  // server and the list here keeps whatever it loaded with. So re-read it when
  // the info dialog opens, which is the only moment the Agent's configuration
  // is on screen (issue #920). Fire-and-forget for the same reason
  // `refreshChat` is: the dialog keeps showing the cached row if this fails,
  // which is exactly the behaviour it has without the refresh.
  useEffect(() => {
    if (!isAgentInfoDialogOpen) return;
    void mutateAgents().catch(() => {});
  }, [isAgentInfoDialogOpen, mutateAgents]);

  // Treat a server-side run-in-progress as if we were locally streaming,
  // so a tab that reconnects mid-run (or an unrelated tab opened on the
  // same chat) can't kick off a second concurrent run. The submit button
  // becomes a stop button and Enter is blocked by PromptInputTextarea.
  // `runHeldElsewhere` comes from `useChatTranscript`, which covers a dropped
  // stream too — see `isRunHeldElsewhere` (issue #648).
  const turnInFlight = isTurnInFlight(effectiveStatus);
  // A Send's Sandbox uploads read as a sent turn on the composer only: the
  // turn has not started, so a press must not reach `turn.cancel()`.
  const composerStatus = sandboxUploads.uploading
    ? "submitted"
    : effectiveStatus;

  // Every entry point starts its turn here — the composer, Regenerate and a
  // resent edit — so all three get the same pre-turn checks and refresh.
  const turn = useChatTurn({
    selection,
    settings,
    search,
    runHeldElsewhere,
    chat: {
      sendMessage,
      regenerate,
      addToolApprovalResponse,
      stop,
      setMessages,
    },
    refreshChat,
    backendUrl,
    scope,
    chatId,
  });

  const { resendEdited } = turn;
  const resendEdit = useCallback(
    (truncateAt: number, message: PromptInputMessage) =>
      resendEdited(truncateAt, message, parentOf.get(messages[truncateAt]?.id)),
    [parentOf, messages, resendEdited],
  );

  const {
    editing,
    handleMessageEditStart,
    handleMessageEditCancel,
    handleMessageEditSubmit,
  } = useMessageEditing(messages, resendEdit);

  // Escape is the stop button's shortcut, so it goes through the same
  // `turn.cancel()`. It never does two things at once: a press another handler
  // claimed (the slash-command picker), or one made in a surface Escape closes,
  // is left alone, and so is every press while the message editor is open —
  // its Escape cancels the edit even once focus has left its textarea.
  const { cancel } = turn;
  const canEscapeCancel = turnInFlight && !editing;
  useEffect(() => {
    if (!canEscapeCancel) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        event.defaultPrevented ||
        event.isComposing ||
        event.repeat ||
        (event.target instanceof Element && event.target.closest(ESCAPE_OWNERS))
      ) {
        return;
      }
      cancel();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [canEscapeCancel, cancel]);

  const handleCopyMessage = useCallback(
    async (content: string, messageId: string) => {
      if (await copyWithToast(content)) {
        setCopiedMessageId(messageId);
        scheduleCopiedReset(() => setCopiedMessageId(null), 2000);
      }
    },
    [setCopiedMessageId, scheduleCopiedReset],
  );

  // Context occupancy (ADR-0018): the capacity comes from the Org Admin's
  // declaration on the resolved model (`resolvedModel.contextWindow`), the
  // reading from the latest assistant message that CARRIES one. It rides in
  // the message metadata, so it survives a reload rather than staying blank
  // until the next send, and a cancelled turn keeps whatever the run reported.
  //
  // Latest-that-carries-one rather than simply the latest: a turn in flight has
  // no reading until its first step finishes, and blanking the meter over that
  // gap would hide it exactly while the reader is watching. A run that reported
  // a count and then stopped reporting writes a concrete `null`, which IS
  // carried and hides the meter — that erasure is deliberate, so the key's
  // presence is the test rather than its value.
  //
  // Either number missing hides the meter. The composer decides a missing
  // window shows the hint instead; `ContextMeter` keeps its own guard for
  // standalone reuse.
  const contextOccupancy = messages
    .filter(
      (m) => m.role === "assistant" && "contextOccupancy" in (m.metadata ?? {}),
    )
    .at(-1)?.metadata?.contextOccupancy;

  // What the NEXT call starts at, not what the last one was sent: that reply is
  // part of the Transcript now and gets re-sent with it. Both figures are the
  // vendor's; the unsent draft stays uncounted because nothing here can count
  // it. `nextTurnOccupancy` is shared with the backend, which gates clearing's
  // first call on the same derivation (`initialOccupancyFrom`) — the meter and
  // the clearing it explains cannot read one turn differently.
  const projectedOccupancy = nextTurnOccupancy(contextOccupancy);

  // The Transcript summary this Chat actually reads (ADR-0041, issue #1716):
  // the deepest one usable on the current Active path — a Delete inside its
  // range, or of the user message after its anchor, makes a summary unusable
  // and the next one up takes its place.
  const appliedSummary = appliedTranscriptSummary(
    messages,
    chatData?.summaries,
  );

  // After a summary is taken and before the next turn reports a reading, the
  // number on the meter describes the view the summary replaced — so it shows
  // "—" with no note instead of a figure the next call will not start at.
  const occupancyAfterSummary = occupancyIsStaleAfterSummary(
    messages,
    chatData?.summaries,
  );

  // The status this turn streamed while it waited for a summary (ADR-0041),
  // read off the Run event the backend put at the head of the turn.
  const summarisingStatus = summarisingStatusOf(messages, turnInFlight);

  // Tool-result clearing (ADR-0018 Notes, issue #524): which tool results the
  // NEXT model call would no longer receive, derived from the same reading the
  // meter above shows rather than a stored flag — a message this session
  // hasn't reloaded can't carry a stale one. `useStableSet` keeps the memo on
  // `ChatMessage` intact while clearing is active: a streamed token changes
  // text, not the set of cleared results (issue #869).
  //
  // Computed above the early returns below: `useStableSet` is a hook, so it
  // cannot sit after a conditional return.
  //
  // Tool-input clearing (issue #1722) shares the indication: a write call's
  // input left out reads the same as a read call's result left out.
  const clearingReading = {
    occupancy: projectedOccupancy,
    contextWindow: resolvedModel?.contextWindow,
  };
  const resultClearedIds = clearedToolCallIds(messages, clearingReading);
  const inputClearedIds = clearedInputToolCallIds(messages, clearingReading);
  const staleToolCallIds = useStableSet(
    inputClearedIds.size === 0
      ? resultClearedIds
      : new Set([...resultClearedIds, ...inputClearedIds]),
  );

  // A failed cold read would otherwise hold the skeleton up for good.
  if (providersError && !providersData) {
    return (
      <div className="flex items-center justify-center h-full p-8">
        <div className="w-full xl:w-4/5 max-w-4xl">
          <ListError
            error={providersError}
            subject="providers"
            onRetry={() => void mutateProviders()}
          />
        </div>
      </div>
    );
  }

  // Held while auth loads too: until the session and the Workspace row land,
  // nobody knows whether the reader may send, and the page drawn meanwhile
  // would swap between the read-only notice and the composer. The skeleton
  // draws the composer until then, rather than guess read-only and swap.
  // Messages can reach the screen while auth is still loading; the skeleton
  // keeps the docked layout over them rather than centre the composer.
  if (isLoading || !providersData || isAuthLoading) {
    return (
      <ChatSkeleton
        transcript={isTranscriptPending || messages.length > 0}
        readOnly={!isAuthLoading && !canSendMessages}
      />
    );
  }

  // Show alert if no providers are configured
  if (providers.length === 0) {
    return (
      <div className="flex items-center justify-center h-full p-8">
        <div className="w-full xl:w-4/5 max-w-4xl">
          <NoProvidersEmptyState orgId={orgId} workspaceId={workspaceId} />
        </div>
      </div>
    );
  }

  if (isTranscriptPending) {
    return <ChatSkeleton transcript readOnly={!canSendMessages} />;
  }

  // A dropped connection to a run that is still going: an inline line, and the
  // answer keeps arriving from the poll. The modal is for a turn that failed.
  const isRecoveringRun = errorTreatment === "recovering";

  // Hidden rather than disabled when any condition fails (ADR-0028).
  const canUploadToSandbox = Boolean(
    sandbox?.transfer.upload && selectedAgent?.toolSetIds?.includes("sandbox"),
  );

  // Built-in commands come first, and only once there is a turn to act on.
  // A Skill saved under a built-in's name before it was reserved is left out:
  // typing it runs the built-in.
  const slashCommands: SlashCommand[] = [
    ...(messages.length > 0 ? BUILT_IN_CHAT_COMMANDS : []),
    ...agentSkills.filter((skill) => !isBuiltInChatCommandName(skill.name)),
  ];

  // Sandbox uploads land first; the message goes only once every one has. A
  // rejection keeps the composer's text and chips for a retry.
  const handleSubmit = async (message: PromptInputMessage) => {
    if (turnInFlight) {
      return turn.cancel();
    }
    // `/compact` runs here rather than being sent: it takes a Transcript
    // summary and writes no message (issue #1111). A rejection keeps the text.
    const builtIn = message.files?.length
      ? null
      : builtInCommandOf(message.text);
    if (builtIn?.name === "compact") {
      setCompacting(true);
      const outcome = await compact(builtIn.argument).finally(() =>
        setCompacting(false),
      );
      if (outcome.outcome !== "success") {
        toast.error(outcome.message);
        throw new Error(outcome.message);
      }
      refreshChat();
      return;
    }
    const sandboxFiles = message.sandboxFiles ?? [];
    if (!message.text && !message.files?.length && !sandboxFiles.length) {
      return;
    }
    const uploads = await sandboxUploads.upload(sandboxFiles);
    if (!turn.send({ ...message, sandboxUploads: uploads })) {
      throw new Error("The turn did not start");
    }
  };

  return (
    <div
      className={cn(
        "relative size-full flex flex-col overflow-hidden h-full",
        messages.length === 0 && "justify-center",
      )}
    >
      <h1 className="sr-only">
        {chatData?.title && chatData.title !== UNTITLED_CHAT_TITLE
          ? chatData.title
          : "New chat"}
      </h1>
      {/* The transcript is a live log; marked busy while a reply streams so
          screen readers wait for it rather than reading every token. */}
      <Conversation
        className={cn(
          "overflow-y-hidden",
          messages.length === 0 && "flex-none",
        )}
        data-conversation
        aria-busy={turnInFlight}
      >
        <ConversationContent>
          <div className="flex justify-center">
            {/* The one owner of vertical spacing between chat items: messages,
            Thinking and tool disclosures, Sources and notices carry no margins
            of their own, so every gap in the transcript is this one. */}
            <div className="w-full flex flex-col gap-4 xl:w-4/5 max-w-4xl">
              {chatData?.a2aClientName && (
                <p className="text-center text-xs text-muted-foreground">
                  Over A2A from {chatData.a2aClientName}
                </p>
              )}
              {messages.map((message, messageIndex) => (
                // A long transcript keeps every message in the DOM, rendered
                // diagrams and highlighted code included; the browser skips
                // laying out and painting the ones off screen. `auto` in the
                // intrinsic size remembers each one's real height once it has
                // rendered, so scrolling back over it does not jump. The last
                // message gets it too: one first given containment when the
                // next message lands has no remembered size, so for a frame
                // it is 160px, the transcript collapses and the scroll resets.
                // The padding cancelled by the margin keeps focus rings at the
                // edge outside the paint clip this sets.
                <div
                  key={message.id}
                  className="-m-1 flex flex-col gap-4 p-1 [contain-intrinsic-size:auto_160px] [content-visibility:auto]"
                >
                  <ChatMessage
                    message={message}
                    isLastMessage={messageIndex === messages.length - 1}
                    status={status}
                    canSendMessages={canSendMessages}
                    editor={
                      editing?.messageId === message.id ? (
                        <MessageEditor
                          // Remounted per message, so the surface reseeds from
                          // the message it was opened on rather than carrying
                          // the last one's text and attachments over.
                          key={editing.messageId}
                          initialText={editing.text}
                          initialAttachments={editing.attachments}
                          modelSelection={modelSelection}
                          passthroughFileTypes={
                            resolvedModel?.passthroughFileTypes ?? []
                          }
                          onSubmit={handleMessageEditSubmit}
                          onCancel={handleMessageEditCancel}
                        />
                      ) : undefined
                    }
                    agents={agents}
                    onEditStart={handleMessageEditStart}
                    onMessageDelete={deleteMessage}
                    onRegenerate={
                      isRegenerable(messageIndex) ? turn.regenerate : undefined
                    }
                    alternatives={positions.get(message.id)}
                    onSwitchAlternative={switchAlternative}
                    onCopyMessage={handleCopyMessage}
                    copiedMessageId={copiedMessageId}
                    staleToolCallIds={staleToolCallIds}
                    onApprovalResponse={
                      // Only the Active leaf can be resumed, and only while
                      // no turn holds the Chat.
                      canSendMessages &&
                      !turnInFlight &&
                      messageIndex === messages.length - 1
                        ? turn.respond
                        : undefined
                    }
                  />
                  {/* The divider sits after the summary's anchor — the last
                      message it covers — and expands to the summary text.
                      Every message above it stays readable. */}
                  {appliedSummary?.anchorIndex === messageIndex && (
                    <TranscriptSummaryDivider
                      summary={appliedSummary.summary}
                    />
                  )}
                </div>
              ))}
            </div>
          </div>
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>
      <TurnAnnouncer status={effectiveStatus} />
      <div className="grid shrink-0 gap-4 p-4">
        <div className="flex justify-center min-w-0">
          <div className="relative w-full xl:w-4/5 max-w-4xl min-w-0">
            {isRecoveringRun && <ChatReconnectingNotice />}
            {(summarisingStatus || compacting) && (
              // This copy is the live region for a streamed status too: the
              // transcript's copy sits inside the busy transcript, and is
              // drawn for the eye rather than announced again.
              <TurnStatus className="mb-2 sm:mb-1">
                {summarisingStatus ?? COMPACTING_STATUS}
              </TurnStatus>
            )}
            {canSendMessages ? (
              <ChatComposer
                onSubmit={handleSubmit}
                canUploadToSandbox={canUploadToSandbox}
                commands={slashCommands}
                slashEnabled={slashCommands.length > 0}
                className={messages.length === 0 ? "min-h-24" : undefined}
                placeholder={
                  runHeldElsewhere
                    ? "Run in progress…"
                    : selectedAgent?.inputPlaceholder ||
                      "What would you like to know?"
                }
                status={composerStatus}
                disabled={runHeldElsewhere || compacting}
                passthroughFileTypes={resolvedModel?.passthroughFileTypes ?? []}
                modelSelection={modelSelection}
                tools={
                  <>
                    {resolvedModel?.canSearch && (
                      <Tooltip delayDuration={1000}>
                        <TooltipTrigger asChild>
                          <PromptInputButton
                            aria-label="Search"
                            onClick={() => setSearch(!search)}
                            variant={search ? "default" : "ghost"}
                          >
                            <GlobeIcon size={16} />
                          </PromptInputButton>
                        </TooltipTrigger>
                        <TooltipContent>Search</TooltipContent>
                      </Tooltip>
                    )}
                    {agentId && selectedAgent && (
                      <Dialog
                        open={isAgentInfoDialogOpen}
                        onOpenChange={setIsAgentInfoDialogOpen}
                      >
                        <Tooltip delayDuration={1000}>
                          <DialogTrigger asChild>
                            <TooltipTrigger asChild>
                              <PromptInputButton aria-label="Agent info">
                                <Info />
                              </PromptInputButton>
                            </TooltipTrigger>
                          </DialogTrigger>
                          <TooltipContent>Agent info</TooltipContent>
                        </Tooltip>
                        <AgentInfoDialog
                          agent={selectedAgent}
                          agents={agents}
                          toolSets={toolSets}
                          skills={skills}
                          providers={providers}
                          onClose={() => setIsAgentInfoDialogOpen(false)}
                        />
                      </Dialog>
                    )}
                    {!agentId && (
                      <Dialog
                        open={isSettingsDialogOpen}
                        onOpenChange={setIsSettingsDialogOpen}
                      >
                        <Tooltip delayDuration={1000}>
                          <DialogTrigger asChild>
                            <TooltipTrigger asChild>
                              <PromptInputButton aria-label="Settings">
                                <Settings2 />
                              </PromptInputButton>
                            </TooltipTrigger>
                          </DialogTrigger>
                          <TooltipContent>Settings</TooltipContent>
                        </Tooltip>
                        <ChatSettingsDialog
                          settings={settings}
                          reasoning={resolvedModel?.reasoning}
                          onChange={updateSettings}
                          onClose={() => setIsSettingsDialogOpen(false)}
                        />
                      </Dialog>
                    )}
                  </>
                }
                footerContent={
                  // Two placements from one element, because the footer wraps.
                  // Narrow: ordered last onto a row of its own, so the tools and
                  // Send keep the first row to themselves and Send is never
                  // pushed off the edge. The row bleeds back over the footer's
                  // own padding — hence the negative margins and the width that
                  // adds them back — so the tint reaches the composer's edges and
                  // reads as a band rather than a chip floating in the middle.
                  // Wide: back in source order with `mr-auto` eating the free
                  // space, which reads as the last item of the tool row rather
                  // than drifting into the middle the way `justify-between`
                  // alone would leave it.
                  <AnimatePresence initial={false}>
                    {contextWindow != null
                      ? (occupancyAfterSummary ||
                          projectedOccupancy != null) && (
                          <ContextMeterEntrance
                            key="context-meter"
                            className={CONTEXT_FOOTER_PLACEMENT}
                          >
                            {occupancyAfterSummary ? (
                              <span className="mt-1.5 inline-block text-xs text-muted-foreground tabular-nums sm:mt-0">
                                —
                              </span>
                            ) : (
                              <ContextMeter
                                className={cn(
                                  CONTEXT_FOOTER_BAND,
                                  "justify-center sm:justify-start",
                                )}
                                occupancy={projectedOccupancy}
                                contextWindow={contextWindow}
                              />
                            )}
                          </ContextMeterEntrance>
                        )
                      : resolvedModel && (
                          <ContextMeterEntrance
                            key="context-window-hint"
                            className={CONTEXT_FOOTER_PLACEMENT}
                          >
                            <ContextWindowHint
                              href={contextWindowHref}
                              className={cn(
                                CONTEXT_FOOTER_BAND,
                                "text-center sm:text-left",
                              )}
                            />
                          </ContextMeterEntrance>
                        )}
                  </AnimatePresence>
                }
                // Named, not tooltipped: a Radix tooltip closes on Escape and
                // would swallow the first press meant to stop the turn.
                submit={
                  <PromptInputSubmit
                    status={composerStatus}
                    {...(turnInFlight && { "aria-label": "Stop (Esc)" })}
                  />
                }
              />
            ) : (
              <div className="flex items-center justify-center py-4 px-6 border rounded-lg bg-muted/50">
                <p className="text-sm text-muted-foreground">
                  Read-only mode. Only the workspace owner can send messages.
                </p>
              </div>
            )}
          </div>
        </div>
      </div>

      {sandboxUploads.dialog}

      {/* Error Dialog */}
      <ChatErrorDialog
        isOpen={showErrorDialog}
        onOpenChange={setShowErrorDialog}
        error={error}
      />
    </div>
  );
}
