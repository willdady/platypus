"use client";

import { Action, Actions } from "@/components/ui/shadcn-io/ai/actions";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Message, MessageContent } from "@/components/ui/shadcn-io/ai/message";
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
import { Response } from "@/components/ui/shadcn-io/ai/response";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { CopyIcon, GlobeIcon, TrashIcon } from "lucide-react";
import { useState, useEffect, useRef } from "react";
import { Model } from "@agent-kit/schemas";

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL;

export const Chat = ({
  orgId,
  workspaceId,
}: {
  orgId: string;
  workspaceId: string;
}) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [model, setModel] = useState("google/gemini-2.5-flash");
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
  const [models, setModels] = useState<Model[]>([]);

  useEffect(() => {
    const fetchModels = async () => {
      const response = await fetch(`${BACKEND_URL}/models`);
      if (!response.ok) {
        throw new Error("Failed to fetch models");
      }
      const data = await response.json();
      if (data.results.length === 0) {
        throw new Error("No models available");
      }
      setModels(data.results);
      setModel(data.results[0].id);
    };
    fetchModels();
  }, []);

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
            <div className="w-full xl:w-3/5">
              {messages.map((message) => (
                <Message key={message.id} from={message.role}>
                  <MessageContent>
                    {message.parts?.map((part, i) => {
                      switch (part.type) {
                        case "text":
                          return (
                            <Response key={`${message.id}-${i}`}>
                              {part.text}
                            </Response>
                          );
                        case "tool-convertFahrenheitToCelsius":
                          switch (part.state) {
                            case "input-streaming":
                              return (
                                <pre key={`${message.id}-${i}`}>
                                  {JSON.stringify(part.input, null, 2)}
                                </pre>
                              );
                            case "input-available":
                              return (
                                <pre key={`${message.id}-${i}`}>
                                  {JSON.stringify(part.input, null, 2)}
                                </pre>
                              );
                            case "output-available":
                              return (
                                <pre key={`${message.id}-${i}`}>
                                  {JSON.stringify(part.output, null, 2)}
                                </pre>
                              );
                            case "output-error":
                              return (
                                <div key={`${message.id}-${i}`}>
                                  Error: {part.errorText}
                                </div>
                              );
                          }
                        default:
                          "text";
                          return null;
                      }
                    })}
                    {message.role === "assistant" && (
                      <Actions className="mt-2">
                        <Action
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
                          tooltip={copied ? "Copied!" : "Copy (⌘C)"}
                          variant={copied ? "secondary" : "ghost"}
                          size="icon"
                          label="Copy"
                        >
                          <CopyIcon className="size-4" />
                        </Action>
                        <Action
                          onClick={() => {
                            const index = messages.findIndex(
                              (m) => m.id === message.id,
                            );
                            setMessages(messages.slice(0, index));
                          }}
                          tooltip="Delete this message and all after it"
                          variant="ghost"
                          size="icon"
                          label="Delete"
                        >
                          <TrashIcon className="size-4" />
                        </Action>
                      </Actions>
                    )}
                  </MessageContent>
                </Message>
              ))}
            </div>
          </div>
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>
      <div className="grid shrink-0 gap-4 p-4">
        <div className="flex justify-center">
          <div className="w-full xl:w-3/5">
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
