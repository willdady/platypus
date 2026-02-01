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
import { useRef, useEffect, useState } from "react";
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
  } = useChat<PlatypusUIMessage>({
    id: chatId,
    transport: new DefaultChatTransport({
      api: joinUrl(
        backendUrl || "",
        `/organizations/${orgId}/workspaces/${workspaceId}/chat`,
      ),
      body: {
        orgId,
        workspaceId,
      },
      credentials: "include",
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

  // Create getRequestBody function that depends on extracted values
  const getRequestBody = () => {
    return agentId
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
  };

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

  // Initialize messages from existing chat data
  useEffect(() => {
    if (chatData?.messages && chatData.messages.length > 0) {
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
  useEffect(() => {
    setSearch(false);
  }, [modelId, providerId]);

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
            <div className="w-full xl:w-4/5 max-w-4xl flex flex-col gap-2">
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
