"use client";

import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import {
  PromptInput,
  PromptInputActionAddAttachments,
  PromptInputActionMenu,
  PromptInputActionMenuContent,
  PromptInputActionMenuTrigger,
  PromptInputAttachment,
  PromptInputAttachments,
  PromptInputBody,
  PromptInputButton,
  PromptInputFooter,
  PromptInputSpeechButton,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  type PromptInputMessage,
} from "@/components/ai-elements/prompt-input";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { GlobeIcon, Info, Settings2 } from "lucide-react";
import { useRef, useEffect, useState, useCallback, useMemo } from "react";
import {
  Chat as ChatType,
  Provider,
  Agent,
  ToolSet,
  Skill,
} from "@platypus/schemas";
import { type PlatypusUIMessage } from "@platypus/backend/src/types";
import useSWR from "swr";
import { fetcher, joinUrl } from "@/lib/utils";
import { useResetOnChange } from "@/hooks/use-reset-on-change";
import { useChatSettings } from "@/hooks/use-chat-settings";
import { useModelSelection } from "@/hooks/use-model-selection";
import { useMessageEditing } from "@/hooks/use-message-editing";
import { useChatMetadata } from "@/hooks/use-chat-metadata";
import { useChatUI } from "@/hooks/use-chat-ui";
import { Dialog, DialogTrigger } from "./ui/dialog";
import { useBackendUrl } from "@/app/client-context";
import { useAuth } from "@/components/auth-provider";
import { NoProvidersEmptyState } from "./no-providers-empty-state";
import { AgentInfoDialog } from "./agent-info-dialog";
import { ChatSettingsDialog } from "./chat-settings-dialog";
import { ErrorDialog } from "./error-dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ChatMessage } from "./chat-message";
import { ModelSelectorDialog } from "./model-selector-dialog";
import { toast } from "sonner";

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
  const { user, isWorkspaceOwner } = useAuth();
  const backendUrl = useBackendUrl();

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [search, setSearch] = useState(false);
  const [inputValue, setInputValue] = useState("");

  // Fetch providers
  const { data: providersData, isLoading } = useSWR<{ results: Provider[] }>(
    backendUrl && user
      ? joinUrl(
          backendUrl,
          `/organizations/${orgId}/workspaces/${workspaceId}/providers`,
        )
      : null,
    fetcher,
  );

  // Memoize providers to prevent unnecessary re-renders
  const providers = useMemo(
    () => providersData?.results || [],
    [providersData?.results],
  );

  // Fetch agents
  const { data: agentsData } = useSWR<{ results: Agent[] }>(
    backendUrl && user
      ? joinUrl(
          backendUrl,
          `/organizations/${orgId}/workspaces/${workspaceId}/agents`,
        )
      : null,
    fetcher,
  );

  // Memoize agents to prevent unnecessary re-renders
  const agents = useMemo(
    () => agentsData?.results || [],
    [agentsData?.results],
  );

  // Fetch tool sets
  const { data: toolSetsData } = useSWR<{ results: ToolSet[] }>(
    backendUrl && user
      ? joinUrl(
          backendUrl,
          `/organizations/${orgId}/workspaces/${workspaceId}/tools`,
        )
      : null,
    fetcher,
  );

  // Memoize tool sets to prevent unnecessary re-renders
  const toolSets = useMemo(
    () => toolSetsData?.results || [],
    [toolSetsData?.results],
  );

  // Fetch skills
  const { data: skillsData } = useSWR<{ results: Skill[] }>(
    backendUrl && user
      ? joinUrl(
          backendUrl,
          `/organizations/${orgId}/workspaces/${workspaceId}/skills`,
        )
      : null,
    fetcher,
  );
  // Memoize skills to prevent unnecessary re-renders
  const skills = useMemo(
    () => skillsData?.results || [],
    [skillsData?.results],
  );

  // Fetch existing chat data. Poll while the server reports the run is
  // still in progress so users who reconnect mid-run see partial messages
  // land without manually reloading. Stop polling once the run reaches a
  // terminal status.
  const { data: chatData, isLoading: isChatLoading } = useSWR<ChatType>(
    backendUrl && user
      ? joinUrl(
          backendUrl,
          `/organizations/${orgId}/workspaces/${workspaceId}/chat/${chatId}`,
        )
      : null,
    fetcher,
    {
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      refreshInterval: (data) => (data?.status === "running" ? 3000 : 0),
    },
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
    // Transport: `body` is a function so it's re-evaluated on every request.
    // This ensures dynamic values like agentId and model config are always current.
    // We use `getRequestBodyRef` (a ref) to avoid stale closures since this
    // transport instance is created once and captured by useChat. The `body`
    // callback reads the ref at request time (not during render), which the
    // static analysis can't prove from the construction site.
    // eslint-disable-next-line react-hooks/refs
    transport: new DefaultChatTransport({
      api: joinUrl(
        backendUrl || "",
        `/organizations/${orgId}/workspaces/${workspaceId}/chat`,
      ),
      body: () => {
        const currentBody = getRequestBodyRef.current?.() || {};
        return {
          orgId,
          workspaceId,
          ...currentBody,
        };
      },
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

  // Custom hooks for state management (must be called before any conditional returns)
  const {
    selection,
    handleModelChange,
    setters: modelSetters,
  } = useModelSelection(
    chatData,
    providers,
    agents,
    isChatLoading,
    workspaceId,
  );
  const { settings, setters } = useChatSettings(chatData, selection.agentId);
  const chatUI = useChatUI(error);

  // Extract values from hooks for easier access
  const { agentId, modelId, providerId } = selection;
  const {
    systemPrompt,
    temperature,
    topP,
    topK,
    seed,
    presencePenalty,
    frequencyPenalty,
  } = settings;
  const {
    isModelSelectorOpen,
    setIsModelSelectorOpen,
    isSettingsDialogOpen,
    setIsSettingsDialogOpen,
    isAgentInfoDialogOpen,
    setIsAgentInfoDialogOpen,
    showErrorDialog,
    setShowErrorDialog,
    copiedMessageId,
    setCopiedMessageId,
  } = chatUI;

  // Use ref to store getRequestBody so the transport callback can access current values
  const getRequestBodyRef = useRef<(() => Record<string, unknown>) | undefined>(
    undefined,
  );

  // Create getRequestBody function that depends on extracted values
  const getRequestBody = useCallback(() => {
    const baseBody = agentId
      ? { agentId, search }
      : {
          providerId,
          modelId,
          systemPrompt: systemPrompt || undefined,
          temperature,
          topP,
          topK,
          seed,
          presencePenalty,
          frequencyPenalty,
          search,
        };

    return baseBody;
  }, [
    agentId,
    providerId,
    modelId,
    systemPrompt,
    temperature,
    topP,
    topK,
    seed,
    presencePenalty,
    frequencyPenalty,
    search,
  ]);

  // Update ref whenever getRequestBody changes. Written in an effect (not
  // during render) so the transport body callback reads the latest value.
  useEffect(() => {
    getRequestBodyRef.current = getRequestBody;
  }, [getRequestBody]);

  // Message editing hook (needs getRequestBody to be defined)
  const messageEditing = useMessageEditing(
    messages,
    setMessages,
    sendMessage,
    getRequestBody,
  );
  const {
    editingMessageId,
    editContent,
    editTextareaRef,
    handleMessageEditStart,
    handleMessageEditCancel,
    handleMessageEditSubmit,
  } = messageEditing;

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

  useEffect(() => {
    if (
      chatData?.messages &&
      chatData.messages.length > 0 &&
      statusRef.current !== "streaming" &&
      statusRef.current !== "submitted"
    ) {
      setMessages(chatData.messages);
    }
  }, [chatData, setMessages]);

  // Use chat metadata hook
  useChatMetadata(
    messages,
    status,
    chatId,
    orgId,
    workspaceId,
    providerId,
    agentId,
    agents,
    backendUrl,
  );

  // Set initial agent if provided and no existing chat agent
  useEffect(() => {
    if (initialAgentId && !agentId && (!chatData || !chatData.agentId)) {
      modelSetters.setAgentId(initialAgentId);
    }
  }, [initialAgentId, agentId, chatData, modelSetters]);

  // Reset search when model or provider changes
  useResetOnChange(`${modelId}:${providerId}`, () => setSearch(false));

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

  const handleRegenerate = useCallback(() => {
    const body = getRequestBody();
    regenerate({ body });
  }, [getRequestBody, regenerate]);

  const handleMessageDelete = useCallback(
    (messageId: string) => {
      setMessages(messages.filter((m) => m.id !== messageId));
    },
    [messages, setMessages],
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

  const selectedAgent = agentId ? agents.find((a) => a.id === agentId) : null;
  // Resolve the provider backing the current selection, whether that's a raw
  // model (providerId) or an agent (which carries its own providerId). Used to
  // decide whether the chat search toggle is shown.
  const resolvedProviderId = agentId ? selectedAgent?.providerId : providerId;
  const resolvedProvider = resolvedProviderId
    ? providers.find((p) => p.id === resolvedProviderId)
    : null;
  // Show the search toggle only when the resolved provider supports native
  // search (not Bedrock) and hasn't disabled it. Hidden when nothing is
  // resolved yet — we can't search without a model. (#167)
  const canSearch =
    !!resolvedProvider &&
    resolvedProvider.providerType !== "Bedrock" &&
    resolvedProvider.nativeSearchEnabled !== false;

  // Treat a server-side run-in-progress as if we were locally streaming,
  // so a tab that reconnects mid-run (or an unrelated tab opened on the
  // same chat) can't kick off a second concurrent run. The submit button
  // becomes a stop button and Enter is blocked by PromptInputTextarea.
  const isReconnectedToRunningRun =
    chatData?.status === "running" && status === "ready";
  const effectiveStatus = isReconnectedToRunningRun ? "streaming" : status;

  const handleSubmit = async (message: PromptInputMessage) => {
    // Stop the stream if currently streaming or submitted
    if (effectiveStatus === "streaming" || effectiveStatus === "submitted") {
      // The server-side run is decoupled from the request lifecycle, so
      // aborting the local fetch (what `stop()` does) no longer cancels
      // the run. Send an explicit cancel POST so the server stops billing
      // tokens and persists the partial result with status="cancelled".
      void fetch(
        joinUrl(
          backendUrl || "",
          `/organizations/${orgId}/workspaces/${workspaceId}/chat/${chatId}/cancel`,
        ),
        { method: "POST", credentials: "include" },
      ).catch(() => {
        // Swallow: the user can retry by pressing stop again, and the
        // server treats repeated cancels as idempotent no-ops.
      });
      return stop();
    }

    const hasText = Boolean(message.text);
    const hasAttachments = Boolean(message.files?.length);
    if (!(hasText || hasAttachments)) {
      return;
    }

    if (!agentId && (!modelId || !providerId)) {
      toast.error("Please select a model or agent to start the chat");
      return;
    }

    // Convert blob: URLs to data: URLs so the backend can access the file
    // content. blob: URLs are browser-only references that can't be resolved
    // server-side.
    const files = await Promise.all(
      (message.files ?? []).map(async (file) => {
        if (!file.url.startsWith("blob:")) return file;
        const res = await fetch(file.url);
        const blob = await res.blob();
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });
        return { ...file, url: dataUrl };
      }),
    );

    const body = getRequestBody();

    sendMessage(
      {
        text: message.text || "Sent with attachments",
        files,
      },
      { body },
    );
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
            <div className="w-full flex flex-col gap-2 xl:w-4/5 max-w-4xl">
              {messages.map((message, messageIndex) => (
                <ChatMessage
                  key={message.id}
                  message={message}
                  isLastMessage={messageIndex === messages.length - 1}
                  status={status}
                  isEditing={editingMessageId === message.id}
                  editContent={editContent}
                  editTextareaRef={editTextareaRef}
                  agents={agents}
                  setEditContent={messageEditing.setEditContent}
                  onEditStart={handleMessageEditStart}
                  onEditCancel={handleMessageEditCancel}
                  onEditSubmit={handleMessageEditSubmit}
                  onMessageDelete={handleMessageDelete}
                  onRegenerate={handleRegenerate}
                  onCopyMessage={handleCopyMessage}
                  copiedMessageId={copiedMessageId}
                />
              ))}
            </div>
          </div>
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>
      <div className="grid shrink-0 gap-4 p-4">
        <div className="flex justify-center">
          <div className="w-full xl:w-4/5 max-w-4xl">
            {isWorkspaceOwner ? (
              <PromptInput
                onSubmit={(message) => {
                  handleSubmit(message);
                  setInputValue("");
                }}
                globalDrop
                multiple
              >
                <PromptInputAttachments className="w-full">
                  {(attachment) => <PromptInputAttachment data={attachment} />}
                </PromptInputAttachments>
                <PromptInputBody>
                  <PromptInputTextarea
                    ref={textareaRef}
                    value={inputValue}
                    onChange={(e) => setInputValue(e.target.value)}
                    className={messages.length === 0 ? "min-h-24" : undefined}
                    placeholder={
                      isReconnectedToRunningRun
                        ? "Run in progress…"
                        : selectedAgent?.inputPlaceholder ||
                          "What would you like to know?"
                    }
                    autoFocus
                    status={effectiveStatus}
                    disabled={isReconnectedToRunningRun}
                  />
                </PromptInputBody>
                <PromptInputFooter>
                  <PromptInputTools>
                    <PromptInputActionMenu>
                      <PromptInputActionMenuTrigger className="cursor-pointer" />
                      <PromptInputActionMenuContent>
                        <PromptInputActionAddAttachments className="cursor-pointer" />
                      </PromptInputActionMenuContent>
                    </PromptInputActionMenu>
                    <Tooltip delayDuration={1000}>
                      <TooltipTrigger asChild>
                        <PromptInputSpeechButton
                          className="cursor-pointer"
                          textareaRef={textareaRef}
                          onTranscriptionChange={setInputValue}
                        />
                      </TooltipTrigger>
                      <TooltipContent>Microphone</TooltipContent>
                    </Tooltip>
                    {canSearch && (
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
                    <ModelSelectorDialog
                      agents={agents}
                      providers={providers}
                      agentId={agentId}
                      modelId={modelId}
                      isOpen={isModelSelectorOpen}
                      onOpenChange={(open) => {
                        setIsModelSelectorOpen(open);
                        if (!open) {
                          setTimeout(() => textareaRef.current?.focus(), 250);
                        }
                      }}
                      onModelChange={handleModelChange}
                    />
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
                          systemPrompt={systemPrompt}
                          onSystemPromptChange={setters.setSystemPrompt}
                          temperature={temperature}
                          onTemperatureChange={setters.setTemperature}
                          seed={seed}
                          onSeedChange={setters.setSeed}
                          topP={topP}
                          onTopPChange={setters.setTopP}
                          topK={topK}
                          onTopKChange={setters.setTopK}
                          presencePenalty={presencePenalty}
                          onPresencePenaltyChange={setters.setPresencePenalty}
                          frequencyPenalty={frequencyPenalty}
                          onFrequencyPenaltyChange={setters.setFrequencyPenalty}
                          onClose={() => setIsSettingsDialogOpen(false)}
                        />
                      </Dialog>
                    )}
                  </PromptInputTools>
                  <PromptInputSubmit status={effectiveStatus} />
                </PromptInputFooter>
              </PromptInput>
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
      <ErrorDialog
        isOpen={showErrorDialog}
        onOpenChange={setShowErrorDialog}
        error={error}
      />
    </div>
  );
};
