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
  PromptInputButton,
  PromptInputFooter,
  PromptInputHeader,
  PromptInputModelSelect,
  PromptInputModelSelectContent,
  PromptInputModelSelectItem,
  PromptInputModelSelectTrigger,
  PromptInputModelSelectValue,
  PromptInputProvider,
  PromptInputSpeechButton,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  type PromptInputMessage,
} from "@/components/ai-elements/prompt-input";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { CopyIcon, GlobeIcon, TrashIcon } from "lucide-react";
import { useState, useRef, Fragment } from "react";
import { Model } from "@agent-kit/schemas";
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "./ai-elements/reasoning";

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL;

export const Chat = ({
  orgId,
  workspaceId,
  models,
  initialModelId,
}: {
  orgId: string;
  workspaceId: string;
  models: Model[];
  initialModelId: string;
}) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [model, setModel] = useState(initialModelId);
  const { messages, setMessages, sendMessage, status } = useChat({
    transport: new DefaultChatTransport({
      api: `${BACKEND_URL}/chat`,
      body: {
        model,
        orgId,
        workspaceId,
      },
    }),
  });
  const [input, setInput] = useState("");
  const [copied, setCopied] = useState(false);

  const handleSubmit = (message: PromptInputMessage) => {
    const hasText = Boolean(message.text);
    const hasAttachments = Boolean(message.files?.length);
    if (!(hasText || hasAttachments)) {
      return;
    }
    sendMessage({ text: message.text! });
  };

  return (
    <div className="relative size-full flex flex-col divide-y overflow-hidden h-[calc(100vh-2.75rem)]">
      <Conversation className="overflow-y-hidden" data-conversation>
        <ConversationContent>
          <div className="flex justify-center">
            <div className="w-full xl:w-4/5 flex flex-col gap-4">
              {messages.map((message) => (
                <Fragment key={message.id}>
                  {message.parts?.map((part, i) => {
                    switch (part.type) {
                      case "text":
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
                      case "reasoning":
                        return (
                          <Fragment key={`${message.id}-${i}`}>
                            <Reasoning
                              key={message.id}
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
                          </Fragment>
                        );
                        
                      default:
                        return null;
                    }
                  })}
                </Fragment>
              ))}
            </div>
          </div>
        </ConversationContent>
        <ConversationScrollButton className="cursor-pointer" />
      </Conversation>
      <div className="grid shrink-0 gap-4 p-4">
        <div className="flex justify-center">
          <div className="w-full xl:w-4/5">
            <PromptInputProvider>
              <PromptInput globalDrop multiple onSubmit={handleSubmit}>
                <PromptInputHeader>
                  <PromptInputAttachments>
                    {(attachment) => (
                      <PromptInputAttachment data={attachment} />
                    )}
                  </PromptInputAttachments>
                </PromptInputHeader>
                <PromptInputBody>
                  <PromptInputTextarea ref={textareaRef} />
                </PromptInputBody>
                <PromptInputFooter>
                  <PromptInputTools>
                    <PromptInputActionMenu>
                      <PromptInputActionMenuTrigger />
                      <PromptInputActionMenuContent>
                        <PromptInputActionAddAttachments />
                      </PromptInputActionMenuContent>
                    </PromptInputActionMenu>
                    <PromptInputSpeechButton textareaRef={textareaRef} />
                    <PromptInputButton>
                      <GlobeIcon size={16} />
                      <span>Search</span>
                    </PromptInputButton>
                    <PromptInputModelSelect
                      onValueChange={setModel}
                      value={model}
                    >
                      <PromptInputModelSelectTrigger>
                        <PromptInputModelSelectValue />
                      </PromptInputModelSelectTrigger>
                      <PromptInputModelSelectContent>
                        {models.map((modelOption) => (
                          <PromptInputModelSelectItem
                            key={modelOption.id}
                            value={modelOption.id}
                          >
                            {modelOption.name}
                          </PromptInputModelSelectItem>
                        ))}
                      </PromptInputModelSelectContent>
                    </PromptInputModelSelect>
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
