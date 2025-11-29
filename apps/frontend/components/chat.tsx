"use client";

import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import {
  Message,
  MessageContent,
  MessageResponse,
  MessageActions,
  MessageAction,
  MessageAttachments,
  MessageAttachment,
} from "@/components/ai-elements/message";
import {
  PromptInput,
  PromptInputActionAddAttachments,
  PromptInputActionMenu,
  PromptInputActionMenuContent,
  PromptInputActionMenuTrigger,
  PromptInputAttachment,
  PromptInputAttachments,
  PromptInputBody,
  PromptInputFooter,
  PromptInputProvider,
  PromptInputSpeechButton,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  type PromptInputMessage,
} from "@/components/ai-elements/prompt-input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, ToolUIPart } from "ai";
import { CopyIcon, Plus, TrashIcon, TriangleAlert } from "lucide-react";
import { useState, useRef, Fragment, useEffect } from "react";
import { Chat as ChatType, Provider, Agent } from "@agent-kit/schemas";
import useSWR, { useSWRConfig } from "swr";
import { fetcher } from "@/lib/utils";
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "./ai-elements/reasoning";
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from "./ai-elements/tool";
import { Alert, AlertTitle, AlertDescription } from "./ui/alert";
import Link from "next/link";
import { Button } from "./ui/button";
import {
  Source,
  Sources,
  SourcesContent,
  SourcesTrigger,
} from "./ai-elements/sources";
import { useBackendUrl } from "@/app/client-context";

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
  const backendUrl = useBackendUrl();

  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // State for selected model, provider, and agent
  const [agentId, setAgentId] = useState("");
  const [modelId, setModelId] = useState("");
  const [providerId, setProviderId] = useState("");
  const [copied, setCopied] = useState(false);
  const hasMutatedRef = useRef(false);

  const { mutate } = useSWRConfig();

  // Fetch providers
  const { data: providersData, isLoading } = useSWR<{ results: Provider[] }>(
    `${backendUrl}/providers?workspaceId=${workspaceId}`,
    fetcher,
  );

  const providers = providersData?.results || [];

  // Fetch agents
  const { data: agentsData } = useSWR<{ results: Agent[] }>(
    `${backendUrl}/agents?workspaceId=${workspaceId}`,
    fetcher,
  );

  const agents = agentsData?.results || [];

  // Fetch existing chat data
  const { data: chatData, mutate: mutateChatData } = useSWR<ChatType>(
    `${backendUrl}/chat/${chatId}?workspaceId=${workspaceId}`,
    fetcher,
  );

  const { messages, setMessages, sendMessage, status } = useChat({
    id: chatId,
    transport: new DefaultChatTransport({
      api: `${backendUrl}/chat`,
      body: {
        orgId,
        workspaceId,
      },
    }),
  });

  // Reset hasMutated when chatId changes
  useEffect(() => {
    hasMutatedRef.current = false;
  }, [chatId]);

  // Set initial agent if provided and no existing chat agent
  useEffect(() => {
    if (
      initialAgentId &&
      !agentId &&
      chatData !== undefined &&
      (!chatData || !chatData.agentId)
    ) {
      setAgentId(initialAgentId);
    }
  }, [initialAgentId, agentId, chatData]);

  // Initialize messages from existing chat data
  useEffect(() => {
    if (chatData?.messages && chatData.messages.length > 0) {
      setMessages(chatData.messages);
    }
  }, [chatData, setMessages]);

  // Revalidate the chat list (visible in AppSidebar) when our message array contains exactly 2 messages.
  // This will be true after the first successful response from the backend for a new chat.
  // Only generate a title if the chat has "Untitled" as the title.
  useEffect(() => {
    if (messages.length === 2 && !hasMutatedRef.current && status === "ready") {
      hasMutatedRef.current = true;
      // First, revalidate chat data to ensure we have the latest chat record from the backend
      mutateChatData().then((freshChatData) => {
        // Only generate title if the chat has "Untitled" as its title
        if (freshChatData?.title === "Untitled") {
          // Determine the correct providerId to use for metadata generation
          let providerIdForMetadata = providerId;

          if (agentId) {
            // Agent is selected - use the agent's providerId
            const agent = agents.find((a) => a.id === agentId);
            if (agent?.providerId) {
              providerIdForMetadata = agent.providerId;
            } else {
              console.warn(
                `Agent '${agentId}' not found or missing providerId, falling back to current providerId`,
              );
            }
          }

          // Validate that we have a providerId before making the request
          if (providerIdForMetadata) {
            // Call generate-metadata endpoint
            fetch(
              `${backendUrl}/chat/${chatId}/generate-metadata?workspaceId=${workspaceId}`,
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({ providerId: providerIdForMetadata }),
              },
            )
              .then(() => {
                // Revalidate the chat list
                mutate(`${backendUrl}/chat?workspaceId=${workspaceId}`);
              })
              .catch((error) => {
                console.error("Failed to generate chat metadata:", error);
              });
          } else {
            console.warn("No providerId available for metadata generation");
          }
        }
      });
    }
  }, [
    messages,
    mutate,
    mutateChatData,
    workspaceId,
    chatId,
    providerId,
    agentId,
    agents,
    status,
    backendUrl,
  ]);

  // Restore persisted agent/provider/model from chat data, with validation and fallback
  useEffect(() => {
    if (
      chatData &&
      providers.length > 0 &&
      !modelId &&
      !providerId &&
      !agentId
    ) {
      // Check if chat has an agent
      if (chatData.agentId && agents.length > 0) {
        const agent = agents.find((a) => a.id === chatData.agentId);
        if (agent) {
          // Agent still exists, restore it
          setAgentId(chatData.agentId);
          return;
        } else {
          // Agent was deleted, fall back to provider/model
          console.warn(`Agent '${chatData.agentId}' no longer exists`);
        }
      }

      // Restore provider/model (existing logic)
      const persistedProviderId = chatData.providerId;
      const persistedModelId = chatData.modelId;

      if (persistedProviderId && persistedModelId) {
        // Check if the persisted provider still exists
        const provider = providers.find((p) => p.id === persistedProviderId);
        if (provider) {
          // Check if the persisted model is still available for this provider
          if (provider.modelIds.includes(persistedModelId)) {
            // Both provider and model are valid, restore them
            setProviderId(persistedProviderId);
            setModelId(persistedModelId);
            return;
          } else {
            // Provider exists but model is no longer available, use provider's first model
            console.warn(
              `Model '${persistedModelId}' no longer available for provider '${persistedProviderId}', falling back to first model`,
            );
            setProviderId(persistedProviderId);
            setModelId(provider.modelIds[0]);
            return;
          }
        } else {
          // Provider no longer exists, fall back to first available provider
          console.warn(
            `Provider '${persistedProviderId}' no longer exists, falling back to first available provider`,
          );
        }
      }

      // Fall back to first provider's first model (for new chats or invalid persisted data)
      setModelId(providers[0].modelIds[0]);
      setProviderId(providers[0].id);
    }
  }, [chatData, providers, agents, modelId, providerId, agentId]);

  // TODO: Ideally show a loading indicator here
  if (isLoading) return null;

  // Show alert if no providers are configured
  if (providers.length === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <Alert className="max-w-md">
          <TriangleAlert />
          <AlertTitle>No AI providers configured</AlertTitle>
          <AlertDescription>
            <p className="mb-2">
              You need to configure at least one AI provider to start chatting.
            </p>
            <Button size="sm" asChild>
              <Link
                href={`/${orgId}/workspace/${workspaceId}/settings/providers/create`}
              >
                <Plus /> Create your first provider
              </Link>
            </Button>
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  const handleModelChange = (value: string) => {
    if (value.startsWith("agent:")) {
      // Agent selected
      const newAgentId = value.replace("agent:", "");
      setAgentId(newAgentId);
      setProviderId(""); // Clear provider/model
      setModelId("");
    } else if (value.startsWith("provider:")) {
      // Provider/model selected
      const [_, newProviderId, ...modelIdParts] = value.split(":");
      const newModelId = modelIdParts.join(":");
      setProviderId(newProviderId);
      setModelId(newModelId);
      setAgentId(""); // Clear agent
    }
  };

  const handleSubmit = (message: PromptInputMessage) => {
    const hasText = Boolean(message.text);
    const hasAttachments = Boolean(message.files?.length);
    if (!(hasText || hasAttachments)) {
      return;
    }

    // Send EITHER agentId OR (providerId + modelId)
    const body = agentId ? { agentId } : { providerId, modelId };

    sendMessage(
      {
        text: message.text || "Sent with attachments",
        files: message.files,
      },
      { body },
    );
  };

  return (
    <div className="relative size-full flex flex-col divide-y overflow-hidden h-[calc(100vh-2.75rem)]">
      <Conversation className="overflow-y-hidden" data-conversation>
        <ConversationContent>
          <div className="flex justify-center">
            <div className="w-full xl:w-4/5 max-w-5xl flex flex-col gap-4">
              {messages.map((message) => {
                const fileParts = message.parts?.filter(
                  (part) => part.type === "file",
                );
                const sourceUrlParts = message.parts.filter(
                  (part) => part.type === "source-url",
                );

                return (
                  <Fragment key={message.id}>
                    {fileParts && fileParts.length > 0 && (
                      <MessageAttachments key={`${message.id}`}>
                        {fileParts.map((part, i) => (
                          <MessageAttachment
                            key={`${message.id}-${i}`}
                            data={part}
                          />
                        ))}
                      </MessageAttachments>
                    )}
                    {message.role === "assistant" &&
                      !!sourceUrlParts.length && (
                        <Sources>
                          <SourcesTrigger
                            className="cursor-pointer"
                            count={sourceUrlParts.length}
                          />
                          {sourceUrlParts.map((part, i) => {
                            return (
                              <SourcesContent key={`${message.id}-${i}`}>
                                <Source
                                  key={`${message.id}-${i}`}
                                  href={part.url}
                                  title={part.url}
                                />
                              </SourcesContent>
                            );
                          })}
                        </Sources>
                      )}
                    {message.parts?.map((part, i) => {
                      if (part.type === "text") {
                        return (
                          <Fragment key={`${message.id}-${i}`}>
                            <Message key={message.id} from={message.role}>
                              <MessageContent>
                                <MessageResponse>{part.text}</MessageResponse>
                              </MessageContent>
                            </Message>
                            {message.role === "assistant" && (
                              <MessageActions className="mt-2">
                                <MessageAction
                                  className="cursor-pointer"
                                  onClick={() => {
                                    const text =
                                      message.parts
                                        ?.filter((part) => part.type === "text")
                                        .map((part) => part.text)
                                        .join("") || "";
                                    navigator.clipboard.writeText(text);
                                    setCopied(true);
                                    setTimeout(() => setCopied(false), 2000);
                                  }}
                                  variant={copied ? "secondary" : "ghost"}
                                  size="icon"
                                  label="Copy"
                                >
                                  <CopyIcon className="size-4" />
                                </MessageAction>
                                <MessageAction
                                  className="cursor-pointer"
                                  onClick={() => {
                                    const index = messages.findIndex(
                                      (m) => m.id === message.id,
                                    );
                                    setMessages(messages.slice(0, index));
                                  }}
                                  variant="ghost"
                                  size="icon"
                                  label="Delete"
                                >
                                  <TrashIcon className="size-4" />
                                </MessageAction>
                              </MessageActions>
                            )}
                          </Fragment>
                        );
                      } else if (part.type === "reasoning") {
                        return (
                          <Reasoning
                            key={`${message.id}-${i}`}
                            isStreaming={
                              status === "streaming" &&
                              i === message.parts.length - 1 &&
                              message.id === messages.at(-1)?.id
                            }
                            defaultOpen={false}
                          >
                            <ReasoningTrigger className="cursor-pointer" />
                            <ReasoningContent>{part.text}</ReasoningContent>
                          </Reasoning>
                        );
                      } else if (part.type.startsWith("tool-")) {
                        const toolPart = part as ToolUIPart;
                        return (
                          <Tool key={`${message.id}-${i}`}>
                            <ToolHeader
                              state={toolPart.state}
                              type={toolPart.type}
                            />
                            <ToolContent>
                              <ToolInput input={toolPart.input} />
                              <ToolOutput
                                output={toolPart.output}
                                errorText={toolPart.errorText}
                              />
                            </ToolContent>
                          </Tool>
                        );
                      } else {
                        return null;
                      }
                    })}
                  </Fragment>
                );
              })}
            </div>
          </div>
        </ConversationContent>
        <ConversationScrollButton className="cursor-pointer" />
      </Conversation>
      <div className="grid shrink-0 gap-4 p-4">
        <div className="flex justify-center">
          <div className="w-full xl:w-4/5 max-w-5xl">
            <PromptInputProvider>
              <PromptInput globalDrop multiple onSubmit={handleSubmit}>
                <PromptInputAttachments className="w-full">
                  {(attachment) => <PromptInputAttachment data={attachment} />}
                </PromptInputAttachments>
                <PromptInputBody>
                  <PromptInputTextarea ref={textareaRef} />
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
                    />
                    <Select
                      onValueChange={handleModelChange}
                      value={
                        agentId
                          ? `agent:${agentId}`
                          : `provider:${providerId}:${modelId}`
                      }
                    >
                      <SelectTrigger className="cursor-pointer" size="sm">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {/* Agents Group */}
                        {agents.length > 0 && (
                          <SelectGroup>
                            <SelectLabel>Agents</SelectLabel>
                            {agents.map((agent) => (
                              <SelectItem
                                key={agent.id}
                                value={`agent:${agent.id}`}
                                className="cursor-pointer"
                              >
                                {agent.name}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        )}

                        {/* Providers Group */}
                        {providers.map((provider) => (
                          <SelectGroup key={provider.id}>
                            <SelectLabel>{provider.name}</SelectLabel>
                            {provider.modelIds.map((modelId) => (
                              <SelectItem
                                key={`provider:${provider.id}:${modelId}`}
                                className="cursor-pointer"
                                value={`provider:${provider.id}:${modelId}`}
                              >
                                {modelId}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        ))}
                      </SelectContent>
                    </Select>
                  </PromptInputTools>
                  <PromptInputSubmit status={status} />
                </PromptInputFooter>
              </PromptInput>
            </PromptInputProvider>
          </div>
        </div>
      </div>
    </div>
  );
};
