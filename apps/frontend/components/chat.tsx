"use client";

import { useSearchParams } from "next/navigation";
import { replaceSearchParam } from "@/lib/search-params";
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
import {
  useEffect,
  useCallback,
  useMemo,
  useState,
  type ReactNode,
} from "react";
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
import { chatColumnClass } from "@/lib/artifact-panel-split";
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
import { useMutation } from "@/hooks/use-mutation";
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
import { ArtifactViewer, type ArtifactLive } from "./artifact-viewer";
import {
  artifactLiveFromPart,
  findArtifactToolPart,
  storedArtifactOf,
  type ArtifactOpenTarget,
} from "./artifact-tool-card";
import { ChatArtifactSplit } from "./chat-artifact-split";
import { MessageEditor } from "./message-editor";
import { ChatReconnectingNotice } from "./chat-reconnecting-notice";
import { toast } from "sonner";
import { copyWithToast } from "@/lib/clipboard";
import { ChatComposer } from "./chat-composer";
import { ChatSkeleton } from "./chat-skeleton";
import { ListError } from "./list-state";
import type { ModelPickerConfig } from "./composer";
import {
  builtInCommandOf,
  skillsForAgent,
  type SlashCommand,
} from "@/lib/slash-commands";

const ESCAPE_OWNERS =
  '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]';

const COMPACTING_STATUS = "Summarising the conversation…";

function ChatNotice({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center justify-center h-full p-8">
      <div className="w-full xl:w-4/5 max-w-4xl">{children}</div>
    </div>
  );
}

// why: the narrow row bleeds over the footer's padding so the tint reaches the edges
const CONTEXT_FOOTER_PLACEMENT =
  "order-last -mx-3 w-[calc(100%+1.5rem)] sm:order-none sm:mx-0 sm:mr-auto sm:w-auto";

const CONTEXT_FOOTER_BAND =
  "mt-1.5 rounded-b-md bg-foreground/5 px-3 py-1.5 sm:mt-0 sm:rounded-none sm:bg-transparent sm:p-0";

const ARTIFACT_PARAM = "artifact";
const ARTIFACT_FULL_SCREEN_PARAM = "artifactFullScreen";
const FULL_SCREEN_ON = "1";
const CALL_PREFIX = "call:";

function artifactParamOf(target: ArtifactOpenTarget): string {
  return "id" in target
    ? `${target.id}:${target.version}`
    : `${CALL_PREFIX}${target.toolCallId}`;
}

function artifactTargetFromParam(
  value: string | null,
): ArtifactOpenTarget | null {
  if (!value) return null;
  if (value.startsWith(CALL_PREFIX)) {
    return { toolCallId: value.slice(CALL_PREFIX.length) };
  }
  const split = value.lastIndexOf(":");
  const version = Number(value.slice(split + 1));
  return split > 0 && Number.isInteger(version) && version > 0
    ? { id: value.slice(0, split), version }
    : null;
}

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
  const searchParams = useSearchParams();
  const artifactParam = searchParams.get(ARTIFACT_PARAM);
  const openArtifact = useMemo(
    () => artifactTargetFromParam(artifactParam),
    [artifactParam],
  );
  // why: in the URL beside the open Artifact, so a refresh or a link keeps it
  const artifactFullScreen =
    openArtifact !== null &&
    searchParams.get(ARTIFACT_FULL_SCREEN_PARAM) === FULL_SCREEN_ON;
  const setOpenArtifact = useCallback(
    (target: ArtifactOpenTarget | null) =>
      replaceSearchParam(ARTIFACT_PARAM, target && artifactParamOf(target)),
    [],
  );
  const setArtifactFullScreen = useCallback(
    (on: boolean) =>
      replaceSearchParam(
        ARTIFACT_FULL_SCREEN_PARAM,
        on ? FULL_SCREEN_ON : null,
      ),
    [],
  );
  // why: the count remounts the panel, so re-clicking the same Card resets it
  const [openArtifactCount, setOpenArtifactCount] = useState(0);
  const openArtifactFromCard = useCallback(
    (target: ArtifactOpenTarget) => {
      setOpenArtifact(target);
      setOpenArtifactCount((count) => count + 1);
      setArtifactFullScreen(false);
    },
    [setOpenArtifact, setArtifactFullScreen],
  );
  const closeArtifact = useCallback(() => {
    setOpenArtifact(null);
    setArtifactFullScreen(false);
  }, [setOpenArtifact, setArtifactFullScreen]);
  const chatUrl = joinUrl(
    backendUrl || "",
    `${scopedPath("chat", scope)}/${chatId}`,
  );

  const {
    data: providersData,
    results: providers,
    error: providersError,
    isLoading,
    mutate: mutateProviders,
  } = useScopedList<Provider>("providers", scope);

  const {
    data: agentsData,
    results: agents,
    error: agentsError,
    mutate: mutateAgents,
  } = useScopedList<Agent>("agents", scope);

  const agentsIfLoaded = agentsData?.results;

  const { results: toolSets } = useScopedList<ToolSet>("tools", scope);

  const { data: sandbox } = useScopedSWR<Sandbox | null>("sandbox", scope, {
    fetcher: optionalFetcher,
  });
  const sandboxUploads = useSandboxUploads(
    scopedUrl(backendUrl || "", "sandbox/file", scope),
  );

  const { results: skills } = useScopedList<Skill>("skills", scope);

  const transport = useMemo(
    () =>
      new DefaultChatTransport<PlatypusUIMessage>({
        api: scopedUrl(backendUrl || "", `chat/${chatId}/turns`, scope),
        credentials: "include",
        prepareSendMessagesRequest: prepareChatTurnRequest,
      }),
    [backendUrl, chatId, scope],
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
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
    experimental_throttle: 50,
  });

  const openArtifactPart = useMemo(
    () =>
      openArtifact && "toolCallId" in openArtifact
        ? findArtifactToolPart(messages, openArtifact.toolCallId)
        : undefined,
    [messages, openArtifact],
  );
  const openStoredArtifact =
    openArtifact && "id" in openArtifact
      ? openArtifact
      : openArtifactPart && storedArtifactOf(openArtifactPart);
  const openLiveArtifact: ArtifactLive | undefined = openArtifactPart
    ? artifactLiveFromPart(openArtifactPart)
    : undefined;
  const artifactPanelOpen = Boolean(
    openArtifact && (openStoredArtifact || openLiveArtifact),
  );

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

  const { selection, isResolved, substitution, handleModelChange } =
    useModelSelection({
      chatData: chatData ?? undefined,
      providers,
      agents: agentsIfLoaded,
      isChatLoading: isChatLoading && chatData === undefined,
      workspaceId,
      initialAgentId,
    });
  const { settings, updateSettings } = useChatSettings(
    chatData ?? undefined,
    selection.agentId,
  );

  const [isSettingsDialogOpen, setIsSettingsDialogOpen] = useState(false);
  const [isAgentInfoDialogOpen, setIsAgentInfoDialogOpen] = useState(false);
  const [showErrorDialog, setShowErrorDialog] = useState(false);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const scheduleCopiedReset = useTimeout();

  useResetOnChange(error, () => {
    if (error && errorTreatment === "failure") {
      setShowErrorDialog(true);
    }
  });

  const { agentId, modelId, providerId } = selection;

  const selectedAgent = useMemo(
    () => (agentId ? (agents.find((a) => a.id === agentId) ?? null) : null),
    [agentId, agents],
  );

  const agentSkills = useMemo(
    () => skillsForAgent(skills, selectedAgent ? selectedAgent.skillIds : []),
    [selectedAgent, skills],
  );

  const resolvedModel = resolveModel({
    providers,
    agents,
    selection: { agentId, modelId, providerId },
  });

  const contextWindow = resolvedModel?.contextWindow;

  const contextWindowHref = workspaceRoutes(orgId, workspaceId).settings
    .providers;
  const modelSelection: ModelPickerConfig = {
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
  const { run: compactChat, pending: compacting } = useMutation(
    async (argument?: string) => {
      const outcome = await compact(argument);
      if (outcome.outcome !== "success") {
        toast.error(outcome.message);
        throw new Error(outcome.message);
      }
      refreshChat();
    },
  );

  useResetOnChange(
    resolvedModel === null ? null : resolvedModel.canSearch,
    () => {
      if (resolvedModel && !resolvedModel.canSearch) setSearch(false);
    },
  );

  useEffect(() => {
    if (!isAgentInfoDialogOpen) return;
    void mutateAgents().catch(() => {});
  }, [isAgentInfoDialogOpen, mutateAgents]);

  const turnInFlight = isTurnInFlight(effectiveStatus);
  const composerStatus = sandboxUploads.uploading
    ? "submitted"
    : effectiveStatus;

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

  // why: a reported null is carried on purpose; it hides the meter until the next turn
  const contextOccupancy = messages
    .filter(
      (m) => m.role === "assistant" && "contextOccupancy" in (m.metadata ?? {}),
    )
    .at(-1)?.metadata?.contextOccupancy;

  const projectedOccupancy = nextTurnOccupancy(contextOccupancy);

  const appliedSummary = appliedTranscriptSummary(
    messages,
    chatData?.summaries,
  );

  const occupancyAfterSummary = occupancyIsStaleAfterSummary(
    messages,
    chatData?.summaries,
  );

  const summarisingStatus = summarisingStatusOf(messages, turnInFlight);

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

  if (providersError && !providersData) {
    return (
      <ChatNotice>
        <ListError
          error={providersError}
          subject="providers"
          onRetry={() => void mutateProviders()}
        />
      </ChatNotice>
    );
  }

  if (isLoading || !providersData || isAuthLoading) {
    return (
      <ChatSkeleton
        transcript={isTranscriptPending || messages.length > 0}
        readOnly={!isAuthLoading && !canSendMessages}
      />
    );
  }

  if (providers.length === 0) {
    return (
      <ChatNotice>
        <NoProvidersEmptyState orgId={orgId} workspaceId={workspaceId} />
      </ChatNotice>
    );
  }

  if (isTranscriptPending) {
    return <ChatSkeleton transcript readOnly={!canSendMessages} />;
  }

  if (agentsError && !agentsData && !isResolved) {
    return (
      <ChatNotice>
        <ListError
          error={agentsError}
          subject="agents"
          onRetry={() => void mutateAgents()}
        />
      </ChatNotice>
    );
  }

  const isRecoveringRun = errorTreatment === "recovering";

  const canUploadToSandbox = Boolean(
    sandbox?.transfer.upload &&
    (selectedAgent?.toolSetIds.includes("sandbox") ?? false),
  );

  const slashCommands: SlashCommand[] = [
    ...(messages.length > 0 ? BUILT_IN_CHAT_COMMANDS : []),
    ...agentSkills.filter((skill) => !isBuiltInChatCommandName(skill.name)),
  ];

  const handleSubmit = async (message: PromptInputMessage) => {
    if (turnInFlight) {
      return turn.cancel();
    }
    const builtIn = message.files?.length
      ? null
      : builtInCommandOf(message.text);
    if (builtIn?.name === "compact") {
      await compactChat(builtIn.argument);
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
    <ChatArtifactSplit
      panel={
        artifactPanelOpen ? (
          <ArtifactViewer
            key={openArtifactCount}
            orgId={orgId}
            workspaceId={workspaceId}
            artifactId={openStoredArtifact?.id}
            version={openStoredArtifact?.version}
            live={openLiveArtifact}
            onClose={closeArtifact}
            fullScreen={{
              active: artifactFullScreen,
              onToggle: () => setArtifactFullScreen(!artifactFullScreen),
            }}
            className="size-full"
          />
        ) : null
      }
      fullScreen={artifactFullScreen}
    >
      <div
        className={cn(
          "relative flex h-full min-w-0 flex-1 flex-col overflow-hidden",
          messages.length === 0 && "justify-center",
        )}
      >
        <h1 className="sr-only">
          {chatData?.title && chatData.title !== UNTITLED_CHAT_TITLE
            ? chatData.title
            : "New chat"}
        </h1>
        <Conversation
          className={cn(
            "overflow-y-hidden",
            messages.length === 0 && "flex-none",
          )}
          data-conversation
          aria-busy={
            // why: a screen reader waits for the reply rather than reading every token
            turnInFlight
          }
        >
          <ConversationContent>
            <div className="flex justify-center">
              <div
                className={cn(
                  "flex flex-col gap-4",
                  chatColumnClass(artifactPanelOpen),
                )}
                data-testid="chat-column"
              >
                {chatData?.a2aClientName && (
                  <p className="text-center text-xs text-muted-foreground">
                    Over A2A from {chatData.a2aClientName}
                  </p>
                )}
                {messages.map((message, messageIndex) => (
                  // why: containment on the last message too, or its height is lost and scroll resets
                  <div
                    key={message.id}
                    className="-m-1 flex flex-col gap-4 p-1 [contain-intrinsic-size:auto_160px] [content-visibility:auto]"
                  >
                    <ChatMessage
                      message={message}
                      isLastMessage={messageIndex === messages.length - 1}
                      status={effectiveStatus}
                      canSendMessages={canSendMessages}
                      editor={
                        editing?.messageId === message.id ? (
                          // why: remounted per message, or the editor keeps the last one's text and files
                          <MessageEditor
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
                        isRegenerable(messageIndex)
                          ? turn.regenerate
                          : undefined
                      }
                      alternatives={positions.get(message.id)}
                      onSwitchAlternative={switchAlternative}
                      onCopyMessage={handleCopyMessage}
                      copied={copiedMessageId === message.id}
                      staleToolCallIds={staleToolCallIds}
                      artifactScope={scope}
                      onOpenArtifact={openArtifactFromCard}
                      onApprovalResponse={
                        canSendMessages &&
                        !turnInFlight &&
                        messageIndex === messages.length - 1
                          ? turn.respond
                          : undefined
                      }
                    />
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
            <div
              className={cn(
                "relative min-w-0",
                chatColumnClass(artifactPanelOpen),
              )}
              data-testid="chat-column"
            >
              {isRecoveringRun && <ChatReconnectingNotice />}
              {(summarisingStatus || compacting) && (
                // why: the live region here, because the transcript's copy sits inside the busy log
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
                  passthroughFileTypes={
                    resolvedModel?.passthroughFileTypes ?? []
                  }
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
                  submit={
                    // why: a tooltip closes on Escape and would swallow the press meant to stop
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

        <ChatErrorDialog
          isOpen={showErrorDialog}
          onOpenChange={setShowErrorDialog}
          error={error}
        />
      </div>
    </ChatArtifactSplit>
  );
}
