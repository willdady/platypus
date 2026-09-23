"use client";

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
import { DefaultChatTransport } from "ai";
import { GlobeIcon, Info, Settings2 } from "lucide-react";
import { AnimatePresence } from "motion/react";
import { useRef, useEffect, useCallback, useMemo, useState } from "react";
import {
  Chat as ChatType,
  Provider,
  Agent,
  ToolSet,
  Skill,
  nextTurnOccupancy,
} from "@platypus/schemas";
import { type PlatypusUIMessage } from "@platypus/backend/src/types";
import { joinUrl, optionalFetcher } from "@/lib/utils";
import {
  chatPollIntervalMs,
  classifyChatError,
  composerTurnStatus,
  isRunHeldElsewhere,
  snapshotIsAtLeastAsComplete,
  snapshotMessages,
} from "@/lib/chat-recovery";
import { useScopedSWR } from "@/hooks/use-scoped-swr";
import { useResetOnChange } from "@/hooks/use-reset-on-change";
import { useRevalidateOnRestore } from "@/hooks/use-revalidate-on-restore";
import { useChatSettings } from "@/hooks/use-chat-settings";
import { useModelSelection } from "@/hooks/use-model-selection";
import { resolveModel } from "@/lib/resolve-model";
import { clearedToolCallIds } from "@/lib/tool-result-clearing";
import { useStableSet } from "@/hooks/use-stable-set";
import { ContextMeter, ContextMeterEntrance } from "./context-meter";
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
import { ChatComposer } from "./chat-composer";
import type { ModelSelection } from "./composer";
import { skillsForAgent } from "@/lib/slash-commands";

export const Chat = ({
  orgId,
  workspaceId,
  chatId,
  initialAgentId,
}: {
  orgId: string;
  workspaceId: string;
  chatId: string;
  initialAgentId?: string;
}) => {
  const { ownsWorkspace } = useAuth();
  const canSendMessages = canSendChatMessages(ownsWorkspace);
  const backendUrl = useBackendUrl();
  const scope = useMemo(() => ({ orgId, workspaceId }), [orgId, workspaceId]);

  // Fetch providers
  const { data: providersData, isLoading } = useScopedSWR<{
    results: Provider[];
  }>("providers", scope);

  // Memoize providers to prevent unnecessary re-renders
  const providers = useMemo(
    () => providersData?.results || [],
    [providersData?.results],
  );

  // Fetch agents
  const { data: agentsData, mutate: mutateAgents } = useScopedSWR<{
    results: Agent[];
  }>("agents", scope);

  // Memoize agents to prevent unnecessary re-renders. The model-selection
  // ladder is the one reader that needs "the list has not landed yet" apart
  // from "this workspace has no Agents" (issue #799), so it takes the
  // undefined-until-loaded value; everything else reads the plain list.
  const agentsIfLoaded = useMemo(
    () => agentsData?.results,
    [agentsData?.results],
  );
  const agents = useMemo(() => agentsIfLoaded ?? [], [agentsIfLoaded]);

  // Fetch tool sets
  const { data: toolSetsData } = useScopedSWR<{ results: ToolSet[] }>(
    "tools",
    scope,
  );

  // Memoize tool sets to prevent unnecessary re-renders
  const toolSets = useMemo(
    () => toolSetsData?.results || [],
    [toolSetsData?.results],
  );

  // Fetch skills
  const { data: skillsData } = useScopedSWR<{ results: Skill[] }>(
    "skills",
    scope,
  );
  // Memoize skills to prevent unnecessary re-renders
  const skills = useMemo(
    () => skillsData?.results || [],
    [skillsData?.results],
  );

  const {
    messages,
    setMessages,
    sendMessage,
    status,
    regenerate,
    error,
    stop,
  } = useChat<PlatypusUIMessage>({
    id: chatId,
    // The per-turn body rides each call (`useChatTurn` builds it) and wins the
    // SDK's shallow merge over this one, so the transport carries only what
    // never changes for the Chat (issue #971).
    transport: new DefaultChatTransport({
      api: joinUrl(
        backendUrl || "",
        `/organizations/${orgId}/workspaces/${workspaceId}/chat`,
      ),
      body: { orgId, workspaceId },
      credentials: "include",
      // The AI SDK calls this before each fetch. We must include `id` and
      // `messages` in the body because the backend expects them in the
      // JSON payload (not derived from the URL or headers).
      prepareSendMessagesRequest: (options) => {
        return {
          body: {
            ...options.body,
            id: options.id,
            messages: options.messages,
          },
        };
      },
    }),
  });

  // Whether this turn's stream had started arriving before it broke — what tells
  // a dropped connection from a request the server refused (issue #648).
  //
  // The one thing that tells the two apart: a turn that got bytes passed through
  // `streaming` on its way to `error`, and one that was refused went from
  // `submitted` straight to `error`. Without it, a rejected attachment and a
  // backgrounded tab look identical from the client — both are just an error on
  // the chat hook. Reset at each submit, so the answer is about the turn in hand
  // rather than an earlier one. Kept in state adjusted during render rather than
  // a ref written in an effect: the classification is read on the very render the
  // error appears, and a ref would still be holding the previous render's value.
  const [turnEstablished, setTurnEstablished] = useState(false);
  useResetOnChange(status, () => {
    if (status === "submitted") setTurnEstablished(false);
    else if (status === "streaming") setTurnEstablished(true);
  });

  // Fetch existing chat data, and re-read it while there is reason to believe a
  // run is live so a client that lost its stream sees the partial answer keep
  // filling in. `chatPollIntervalMs` owns that decision, and reads THIS tab's
  // turn status as well as the fetched one: gated on the fetched status alone
  // the poll could never start, because on an existing Chat that status is the
  // previous turn's `succeeded` until something refetches it — and the only
  // thing that would was the poll (issue #648).
  //
  // Focus and reconnect revalidation are deliberately left on (SWR's defaults).
  // They are the "the user came back" and "the network returned" signals, and a
  // frozen mobile tab's timers do not run at all while it is away, so they are
  // the only thing that can wake a poll promptly. Safe to leave on because
  // hydration is monotonic — see the hydrate effect below.
  //
  // `optionalFetcher` because a brand-new Chat is read before its row exists
  // (the run creates it): a thrown 404 would sit in the cache as an error, and
  // SWR does not revalidate on an interval while one is there.
  const {
    data: chatData,
    isLoading: isChatLoading,
    mutate: mutateChat,
  } = useScopedSWR<ChatType | null>(`chat/${chatId}`, scope, {
    fetcher: optionalFetcher,
    refreshInterval: (data) =>
      chatPollIntervalMs({
        runStatus: data?.status,
        turnStatus: status,
        turnEstablished,
      }),
  });

  // Re-read the row from the authority. Nothing here awaits it and a failure is
  // not worth reporting: the poll gate reads this tab's own turn status too, so
  // recovery never depends on one refresh landing.
  const refreshChat = useCallback(() => {
    void mutateChat().catch(() => {});
  }, [mutateChat]);

  // A restored page's poll was frozen the whole time it was away, and a bfcache
  // restore is neither a focus nor a reconnect.
  useRevalidateOnRestore(refreshChat);

  // One reading of "is a run in flight?", shared by the composer guard and the
  // error classification below, so the two cannot disagree.
  const runBelief = {
    runStatus: chatData?.status,
    turnStatus: status,
    turnEstablished,
  };
  const errorTreatment = classifyChatError({ error, ...runBelief });

  // Custom hooks for state management (must be called before any conditional returns)
  const { selection, isResolved, handleModelChange } = useModelSelection({
    chatData: chatData ?? undefined,
    providers,
    agents: agentsIfLoaded,
    // SWR reports a key's first mount as loading even when the cache already
    // holds a value: a row, or the `null` the index route seeds for a new Chat.
    isChatLoading: isChatLoading && chatData === undefined,
    workspaceId,
    initialAgentId,
  });
  const { settings, setters } = useChatSettings(
    chatData ?? undefined,
    selection.agentId,
  );

  // The Chat's own UI state, none of which any other surface shares.
  const [isSettingsDialogOpen, setIsSettingsDialogOpen] = useState(false);
  const [isAgentInfoDialogOpen, setIsAgentInfoDialogOpen] = useState(false);
  const [showErrorDialog, setShowErrorDialog] = useState(false);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);

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
  // What the model picker on both surfaces is configured with (issue #724).
  const modelSelection: ModelSelection = {
    agents,
    providers,
    agentId,
    modelId,
    providerId,
    isResolved,
    onModelChange: handleModelChange,
    maxOutputTokens: resolvedModel?.maxOutputTokens,
  };
  const [search, setSearch] = useState(false);

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
  // `isRunHeldElsewhere` covers a dropped stream too, whose status is `error`
  // rather than `ready` — the reading the old predicate missed (issue #648).
  const runHeldElsewhere = isRunHeldElsewhere(runBelief);
  const effectiveStatus = composerTurnStatus(runBelief, errorTreatment);

  // Every entry point starts its turn here — the composer, Regenerate and a
  // resent edit — so all three get the same pre-turn checks and refresh.
  const turn = useChatTurn({
    selection,
    settings,
    search,
    runHeldElsewhere,
    chat: { sendMessage, regenerate, stop, setMessages },
    refreshChat,
    backendUrl,
    scope,
    chatId,
  });

  const {
    editing,
    handleMessageEditStart,
    handleMessageEditCancel,
    handleMessageEditSubmit,
  } = useMessageEditing(messages, turn.resendEdited);

  // Hydrate chat from persisted data on load (or when chatData changes).
  // We use a ref for status so that this effect only fires when chatData
  // actually changes (e.g. initial fetch or SWR revalidation), NOT when
  // the streaming status transitions. Without this, ending a stream would
  // trigger the effect and overwrite the fresh messages with stale SWR data.
  const statusRef = useRef(status);
  // Written in an effect (not during render) so the hydrate effect below reads
  // the status committed by the previous render.
  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  // Hydration is monotonic: a fetched snapshot lands only where it is at least
  // as far along as what is on screen (issue #648). The chat row is written on a
  // flush interval, so a snapshot fetched mid-run lags the stream by up to one
  // flush — applying it unconditionally is what would make the answer visibly
  // shorten and then grow back. The comparison is made against the live message
  // list through the updater rather than a dependency, so the effect still runs
  // only when `chatData` changes and not on every streamed chunk.
  useEffect(() => {
    const snapshot = snapshotMessages(chatData);
    if (
      !snapshot ||
      statusRef.current === "streaming" ||
      statusRef.current === "submitted"
    ) {
      return;
    }
    setMessages((held) =>
      snapshotIsAtLeastAsComplete(snapshot, held) ? snapshot : held,
    );
  }, [chatData, setMessages]);

  const handleCopyMessage = useCallback(
    async (content: string, messageId: string) => {
      try {
        await navigator.clipboard.writeText(content);
        toast.info("Copied to clipboard");
        setCopiedMessageId(messageId);
        setTimeout(() => setCopiedMessageId(null), 2000);
      } catch {
        toast.error("Failed to copy to clipboard");
      }
    },
    [setCopiedMessageId],
  );

  // An updater, not a slice of the current list: closing over `messages` gave
  // this callback a new identity on every message update, which defeated the
  // `ChatMessage` memo and re-rendered the whole transcript per token (#869).
  const handleMessageDelete = useCallback(
    (messageId: string) => {
      setMessages((held) => held.filter((m) => m.id !== messageId));
    },
    [setMessages],
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
  // Either number missing hides the meter; `ContextMeter` owns that decision.
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

  // Tool-result clearing (ADR-0018 Notes, issue #524): which tool results the
  // NEXT model call would no longer receive, derived from the same reading the
  // meter above shows rather than a stored flag — a message this session
  // hasn't reloaded can't carry a stale one. `useStableSet` keeps the memo on
  // `ChatMessage` intact while clearing is active: a streamed token changes
  // text, not the set of cleared results (issue #869).
  //
  // Computed above the early returns below: `useStableSet` is a hook, so it
  // cannot sit after a conditional return.
  const staleToolCallIds = useStableSet(
    clearedToolCallIds(messages, {
      occupancy: projectedOccupancy,
      contextWindow: resolvedModel?.contextWindow,
    }),
  );

  // TODO: Ideally show a loading indicator here
  if (isLoading || !providersData) return null;

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

  // A dropped connection to a run that is still going: an inline line, and the
  // answer keeps arriving from the poll. The modal is for a turn that failed.
  const isRecoveringRun = errorTreatment === "recovering";

  const handleSubmit = (message: PromptInputMessage) => {
    if (effectiveStatus === "streaming" || effectiveStatus === "submitted") {
      return turn.cancel();
    }
    if (!message.text && !message.files?.length) return;
    turn.send(message);
  };

  return (
    <div
      className={`relative size-full flex flex-col overflow-hidden h-full ${messages.length === 0 ? "justify-center" : ""}`}
    >
      <Conversation
        className={`overflow-y-hidden ${messages.length === 0 ? "flex-none" : ""}`}
        data-conversation
      >
        <ConversationContent>
          <div className="flex justify-center">
            {/* The one owner of vertical spacing between chat items: messages,
            Thinking and tool disclosures, Sources and notices carry no margins
            of their own, so every gap in the transcript is this one. */}
            <div className="w-full flex flex-col gap-4 xl:w-4/5 max-w-4xl">
              {messages.map((message, messageIndex) => (
                <ChatMessage
                  key={message.id}
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
                  onMessageDelete={handleMessageDelete}
                  onRegenerate={turn.regenerate}
                  onCopyMessage={handleCopyMessage}
                  copiedMessageId={copiedMessageId}
                  staleToolCallIds={staleToolCallIds}
                />
              ))}
            </div>
          </div>
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>
      <div className="grid shrink-0 gap-4 p-4">
        <div className="flex justify-center min-w-0">
          <div className="relative w-full xl:w-4/5 max-w-4xl min-w-0">
            {isRecoveringRun && <ChatReconnectingNotice />}
            {canSendMessages ? (
              <ChatComposer
                onSubmit={handleSubmit}
                commands={agentSkills}
                slashEnabled={Boolean(selectedAgent)}
                className={messages.length === 0 ? "min-h-24" : undefined}
                placeholder={
                  runHeldElsewhere
                    ? "Run in progress…"
                    : selectedAgent?.inputPlaceholder ||
                      "What would you like to know?"
                }
                status={effectiveStatus}
                disabled={runHeldElsewhere}
                passthroughFileTypes={resolvedModel?.passthroughFileTypes ?? []}
                modelSelection={modelSelection}
                tools={
                  <>
                    {resolvedModel?.canSearch && (
                      <Tooltip delayDuration={1000}>
                        <TooltipTrigger asChild>
                          <PromptInputButton
                            className="cursor-pointer mr-2"
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
                        <DialogTrigger asChild>
                          <PromptInputButton>
                            <Info />
                          </PromptInputButton>
                        </DialogTrigger>
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
                              <PromptInputButton>
                                <Settings2 />
                              </PromptInputButton>
                            </TooltipTrigger>
                          </DialogTrigger>
                          <TooltipContent>Settings</TooltipContent>
                        </Tooltip>
                        <ChatSettingsDialog
                          instructions={settings.instructions}
                          onInstructionsChange={setters.setInstructions}
                          temperature={settings.temperature}
                          onTemperatureChange={setters.setTemperature}
                          seed={settings.seed}
                          onSeedChange={setters.setSeed}
                          topP={settings.topP}
                          onTopPChange={setters.setTopP}
                          topK={settings.topK}
                          onTopKChange={setters.setTopK}
                          presencePenalty={settings.presencePenalty}
                          onPresencePenaltyChange={setters.setPresencePenalty}
                          frequencyPenalty={settings.frequencyPenalty}
                          onFrequencyPenaltyChange={setters.setFrequencyPenalty}
                          maxSteps={settings.maxSteps}
                          onMaxStepsChange={setters.setMaxSteps}
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
                    {projectedOccupancy != null &&
                      resolvedModel?.contextWindow != null && (
                        <ContextMeterEntrance
                          key="context-meter"
                          className="order-last -mx-3 w-[calc(100%+1.5rem)] sm:order-none sm:mx-0 sm:mr-auto sm:w-auto"
                        >
                          <ContextMeter
                            className="mt-1.5 justify-center rounded-b-md bg-foreground/5 px-3 py-1.5 sm:mt-0 sm:justify-start sm:rounded-none sm:bg-transparent sm:p-0"
                            occupancy={projectedOccupancy}
                            contextWindow={resolvedModel.contextWindow}
                          />
                        </ContextMeterEntrance>
                      )}
                  </AnimatePresence>
                }
                submit={<PromptInputSubmit status={effectiveStatus} />}
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

      {/* Error Dialog */}
      <ChatErrorDialog
        isOpen={showErrorDialog}
        onOpenChange={setShowErrorDialog}
        error={error}
      />
    </div>
  );
};
