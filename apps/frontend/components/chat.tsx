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
import { Provider } from "@agent-kit/schemas";
import useSWR from "swr";
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

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL;

export const Chat = ({
  orgId,
  workspaceId,
}: {
  orgId: string;
  workspaceId: string;
}) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // State for selected model and provider
  const [modelId, setModelId] = useState("");
  const [providerId, setProviderId] = useState("");
  const [copied, setCopied] = useState(false);

  // Fetch providers
  const { data: providersData, isLoading } = useSWR<{ results: Provider[] }>(
    `${BACKEND_URL}/providers?workspaceId=${workspaceId}`,
    fetcher,
  );

  const providers = providersData?.results || [];

  const { messages, setMessages, sendMessage, status } = useChat({
    transport: new DefaultChatTransport({
      api: `${BACKEND_URL}/chat`,
      body: {
        orgId,
        workspaceId,
      },
    }),
  });

  // Initialize with first provider's first model once providers are loaded
  useEffect(() => {
    if (providers.length > 0 && !modelId && !providerId) {
      setModelId(providers[0].modelIds[0]);
      setProviderId(providers[0].id);
    }
  }, [providers, modelId, providerId]);

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
    // Value is in format "providerId:modelId"
    const [newProviderId, newModelId] = value.split(":");
    if (newProviderId && newModelId) {
      setProviderId(newProviderId);
      setModelId(newModelId);
    }
  };

  const handleSubmit = (message: PromptInputMessage) => {
    const hasText = Boolean(message.text);
    const hasAttachments = Boolean(message.files?.length);
    if (!(hasText || hasAttachments)) {
      return;
    }
    sendMessage(
      {
        text: message.text || "Sent with attachments",
        files: message.files,
      },
      {
        body: {
          providerId,
          modelId,
        },
      },
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
                      value={`${providerId}:${modelId}`}
                    >
                      <SelectTrigger className="cursor-pointer" size="sm">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {providers.map((provider) => (
                          <SelectGroup key={provider.id}>
                            <SelectLabel>{provider.name}</SelectLabel>
                            {provider.modelIds.map((modelId) => (
                              <SelectItem
                                key={`${provider.id}:${modelId}`}
                                className="cursor-pointer"
                                value={`${provider.id}:${modelId}`}
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
