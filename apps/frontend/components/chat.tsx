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
import { DefaultChatTransport, lastAssistantMessageIsCompleteWithToolCalls } from "ai";
import { GlobeIcon, Info, Settings2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useRef, useEffect, useState, useCallback } from "react";
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
import { ChatMessage } from "./chat-message";
import { ModelSelectorDialog } from "./model-selector-dialog";
import { toast } from "sonner";
import { useSubAgent } from "@/components/sub-agent-context";

export const Chat = ({
  orgId,
  workspaceId,
  chatId,
  initialAgentId,
  parentChatId,
  initialTask,
  isSubAgentMode,
}: {
  orgId: string;
  workspaceId: string;
  chatId: string;
  initialAgentId?: string;
  parentChatId?: string;
  initialTask?: string | null;
  isSubAgentMode?: boolean;
}) => {
  const { user } = useAuth();
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

  const providers = providersData?.results || [];

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

  const agents = agentsData?.results || [];

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

  const toolSets = toolSetsData?.results || [];

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
  const skills = skillsData?.results || [];

  // Fetch existing chat data
  const { data: chatData, isLoading: isChatLoading } = useSWR<ChatType>(
    backendUrl && user
      ? joinUrl(
          backendUrl,
          `/organizations/${orgId}/workspaces/${workspaceId}/chat/${chatId}`,
        )
      : null,
    fetcher,
  );

  const {
    messages,
    setMessages,
    sendMessage,
    status,
    regenerate,
    error,
    stop,
    addToolOutput,
  } = useChat<PlatypusUIMessage>({
    id: chatId,
    // Transport: `body` is a function so it's re-evaluated on every request,
    // including automatic resubmissions triggered by `sendAutomaticallyWhen`.
    // This ensures dynamic values like agentId and model config are always current.
    // We use `getRequestBodyRef` (a ref) to avoid stale closures since this
    // transport instance is created once and captured by useChat.
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
    // Auto-resubmit when all client-side tool outputs (e.g. newTask results)
    // have been provided, so the parent agent continues its response.
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
  });

  const { sessions, getCompletedSessions, consumeSession, completeSession, restoreSession, isToolCallCompleted } = useSubAgent();
  const completedSessions = getCompletedSessions();
  // Tracks which tool call IDs have already been fed back to addToolOutput
  // within this component's lifetime, preventing duplicate submissions.
  const processedRef = useRef<Set<string>>(new Set());

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
    isSubAgentMode,
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
  const getRequestBodyRef = useRef<(() => any) | undefined>(undefined);

  // Create getRequestBody function that depends on extracted values
  const getRequestBody = useCallback(() => {
    const baseBody = agentId
      ? { agentId }
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

    // Include parentChatId for sub-agent mode
    if (isSubAgentMode && parentChatId) {
      return { ...baseBody, parentChatId };
    }

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
    isSubAgentMode,
    parentChatId,
  ]);

  // Update ref whenever getRequestBody changes
  getRequestBodyRef.current = getRequestBody;

  // Feed completed sub-agent results back to the parent chat as tool outputs.
  // Each sub-agent session corresponds to a `newTask` client-side tool call.
  // When a session completes, we provide the result via `addToolOutput` which,
  // combined with `sendAutomaticallyWhen`, causes the parent chat to
  // automatically resubmit and continue the agent loop.
  //
  // Guards:
  //  - Skip in sub-agent mode (sub-agents don't have sub-agents of their own)
  //  - Wait for status "ready" to avoid injecting outputs mid-stream
  //  - Skip sessions restored from history (already yielded in a prior page load)
  //  - Use processedRef to prevent duplicate addToolOutput calls across re-renders
  useEffect(() => {
    if (isSubAgentMode) return;
    if (status !== "ready") return;

    for (const session of completedSessions) {
      if (processedRef.current.has(session.toolCallId)) continue;

      // Restored sessions already had their results yielded before page reload
      if (isToolCallCompleted(session.toolCallId)) {
        processedRef.current.add(session.toolCallId);
        continue;
      }

      processedRef.current.add(session.toolCallId);

      // Cast required: newTask is a client-side tool (no execute fn) so its
      // output type is `never` in TypeScript, but we need to provide a string.
      (addToolOutput as any)({
        tool: "newTask",
        toolCallId: session.toolCallId,
        output: session.result?.result || "",
      });

      // Mark as consumed so it won't be reprocessed on subsequent renders
      setTimeout(() => consumeSession(session.toolCallId), 100);
    }
  }, [isSubAgentMode, completedSessions, status, addToolOutput, consumeSession, isToolCallCompleted]);

  // Propagate sub-agent errors back to the parent session so the parent chat
  // doesn't wait forever for a result. Handles two failure modes:
  //  1. useChat error (network failure, backend 500, etc.)
  //  2. Stream ended without taskResult being called (e.g. step limit reached)
  //
  // Uses a ref for status so the debounced timeout in case (2) reads the
  // latest value rather than a stale closure.
  const statusRef = useRef(status);
  statusRef.current = status;

  useEffect(() => {
    if (!isSubAgentMode) return;

    // Find the session that corresponds to this sub-agent Chat's chatId
    const mySession = [...sessions.values()].find(
      (s) => s.subChatId === chatId,
    );
    if (!mySession || mySession.result !== null) return;

    // Case 1: useChat reported an error
    if (error) {
      completeSession(mySession.toolCallId, {
        result: `Sub-agent error: ${error.message}`,
        status: "error",
      });
      return;
    }

    // Case 2: Stream ended (status "ready") without calling taskResult.
    // Use a short debounce to avoid false triggers during the brief "ready"
    // state between auto-resubmissions via sendAutomaticallyWhen.
    if (status === "ready" && messages.length > 1) {
      const timer = setTimeout(() => {
        // Re-check status via ref — if it moved back to "streaming"
        // then an auto-resubmit fired and this isn't a terminal state.
        if (statusRef.current !== "ready") return;

        // Re-read the session — taskResult may have completed it while we waited
        const currentSession = sessions.get(mySession.toolCallId);
        if (currentSession?.result !== null) return;

        completeSession(mySession.toolCallId, {
          result: "Sub-agent ended without returning a result",
          status: "error",
        });
      }, 3000);
      return () => clearTimeout(timer);
    }
  }, [isSubAgentMode, error, status, messages.length, chatId, sessions, completeSession]);

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
  // Before calling setMessages, we scan for any prior newTask tool calls and
  // restore their sessions as already-completed. This prevents NewTaskTool's
  // useEffect from re-launching sub-agents that already ran, while still
  // allowing users to click them to view the sub-agent's chat history.
  useEffect(() => {
    if (chatData?.messages && chatData.messages.length > 0) {
      for (const msg of chatData.messages) {
        for (const part of msg.parts || []) {
          if (
            part.type === "tool-newTask" &&
            "toolCallId" in part &&
            (part as any).toolCallId
          ) {
            const toolPart = part as any;
            const input = toolPart.input as {
              subAgentId?: string;
              task?: string;
            };
            restoreSession(
              chatId,
              toolPart.toolCallId,
              input?.subAgentId || "",
              input?.task || "",
            );
          }
        }
      }
      setMessages(chatData.messages);
    }
  }, [chatData, setMessages, restoreSession, chatId]);

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
    isSubAgentMode,
  );

  // Set initial agent if provided and no existing chat agent
  useEffect(() => {
    if (initialAgentId && !agentId && (!chatData || !chatData.agentId)) {
      modelSetters.setAgentId(initialAgentId);
    }
  }, [initialAgentId, agentId, chatData, modelSetters]);

  // Reset search when model or provider changes
  useEffect(() => {
    setSearch(false);
  }, [modelId, providerId]);

  // Track if we've sent the initial task to prevent duplicates
  const initialTaskSentRef = useRef(false);

  // Auto-send initial task for sub-agent mode
  useEffect(() => {
    // Only send initial task if:
    // - We're in sub-agent mode
    // - We have an initial task
    // - No messages exist yet
    // - Agent is selected and chat is ready
    // - Haven't sent yet
    // - Chat data has been loaded (to avoid sending when history exists)
    if (
      isSubAgentMode &&
      initialTask &&
      messages.length === 0 &&
      agentId &&
      status === "ready" &&
      !initialTaskSentRef.current &&
      !isChatLoading && // Wait for chat data to load first
      (!chatData || !chatData.messages || chatData.messages.length === 0) // Only send if no history
    ) {
      initialTaskSentRef.current = true;
      const body = getRequestBody();
      sendMessage(
        { text: initialTask, files: [] },
        { body },
      );
    }
  }, [isSubAgentMode, initialTask, messages.length, agentId, status, sendMessage, getRequestBody, isChatLoading, chatData]);

  // TODO: Ideally show a loading indicator here
  if (isLoading) return null;

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
  const currentProvider = providerId
    ? providers.find((p) => p.id === providerId)
    : null;
  const currentProviderType = currentProvider?.providerType;

  const handleSubmit = (message: PromptInputMessage) => {
    // Stop the stream if currently streaming or submitted
    if (status === "streaming" || status === "submitted") {
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

    const body = getRequestBody();

    sendMessage(
      {
        text: message.text || "Sent with attachments",
        files: message.files,
      },
      { body },
    );
  };

  const handleRegenerate = () => {
    const body = getRequestBody();
    regenerate({ body });
  };

  const handleMessageDelete = (messageId: string) => {
    setMessages(messages.filter((m) => m.id !== messageId));
  };

  return (
    <div
      className={`relative size-full flex flex-col overflow-hidden h-[calc(100vh-2.75rem)] ${messages.length === 0 ? "justify-center" : ""}`}
    >
      <Conversation
        className={`overflow-y-hidden ${messages.length === 0 ? "flex-none" : ""}`}
        data-conversation
      >
        <ConversationContent>
          <div className="flex justify-center">
            <div className={cn("w-full flex flex-col gap-2", !isSubAgentMode && "xl:w-4/5 max-w-4xl")}>
              {messages.map((message, messageIndex) => (
              <ChatMessage
                key={message.id}
                message={message}
                isLastMessage={messageIndex === messages.length - 1}
                status={status}
                isEditing={editingMessageId === message.id}
                editContent={editContent}
                editTextareaRef={editTextareaRef}
                setEditContent={messageEditing.setEditContent}
                onEditStart={handleMessageEditStart}
                onEditCancel={handleMessageEditCancel}
                onEditSubmit={handleMessageEditSubmit}
                onMessageDelete={handleMessageDelete}
                onRegenerate={handleRegenerate}
                onCopyMessage={(content, messageId) => {
                  navigator.clipboard.writeText(content);
                  toast.info("Copied to clipboard");
                  setCopiedMessageId(messageId);
                  setTimeout(() => setCopiedMessageId(null), 2000);
                }}
                copiedMessageId={copiedMessageId}
                onAppendToPrompt={(text) => {
                  setInputValue(text);
                  setTimeout(() => textareaRef.current?.focus(), 0);
                }}
                onSubmitMessage={(text) => {
                  handleSubmit({ text, files: [] });
                }}
                chatId={chatId}
                agents={agents}
                isSubAgentMode={isSubAgentMode}
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
            <PromptInput
              onSubmit={(message, event) => {
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
                  placeholder={
                    selectedAgent?.inputPlaceholder ||
                    "What would you like to know?"
                  }
                  autoFocus
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
                  <PromptInputSpeechButton
                    className="cursor-pointer"
                    textareaRef={textareaRef}
                    onTranscriptionChange={setInputValue}
                  />
                  {(!currentProviderType ||
                    currentProviderType !== "Bedrock") && (
                    <PromptInputButton
                      className="cursor-pointer"
                      onClick={() => setSearch(!search)}
                      variant={search ? "default" : "ghost"}
                    >
                      <GlobeIcon size={16} />
                      <span>Search</span>
                    </PromptInputButton>
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
                      <DialogTrigger asChild>
                        <PromptInputButton>
                          <Settings2 />
                        </PromptInputButton>
                      </DialogTrigger>
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
                <PromptInputSubmit status={status} />
              </PromptInputFooter>
            </PromptInput>
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
