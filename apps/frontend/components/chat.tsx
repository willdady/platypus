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
  usePromptInputController,
  type PromptInputMessage,
} from "@/components/ai-elements/prompt-input";
import { Response } from "@/components/ui/shadcn-io/ai/response";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, UIMessage } from "ai";
import { CopyIcon, GlobeIcon, TrashIcon } from "lucide-react";
import { useState, useEffect, useRef } from "react";
import { Model } from "@agent-kit/schemas";
import { Button } from "./ui/button";

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL;

const TEST_MESSAGES: UIMessage[] = [
  {
    id: "0",
    role: "user",
    parts: [
      {
        type: "text",
        text: "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed ornare hendrerit interdum. Maecenas ullamcorper turpis nisl, ut lacinia neque semper placerat. Sed hendrerit, nulla ut fermentum dignissim, turpis eros ornare mauris, id auctor leo tortor pulvinar felis. Vestibulum leo nisi, venenatis vitae magna in, malesuada scelerisque felis. Etiam luctus massa justo, vitae euismod urna tincidunt et. Donec lectus libero, varius semper quam eget, venenatis convallis neque. Ut eu dui sed dolor vehicula convallis ut et leo. Nulla tempus sagittis ultrices. Maecenas a augue non leo eleifend porttitor. Maecenas pharetra id leo sit amet ullamcorper. Maecenas quis commodo erat. Cras sit amet tincidunt nisi. Vestibulum maximus dapibus egestas.",
      },
    ],
  },
  {
    id: "1",
    role: "assistant",
    parts: [
      {
        type: "text",
        text: "Aenean ac odio ipsum. In sed velit orci. Aliquam hendrerit, mauris blandit suscipit mollis, odio mi sagittis ante, vitae bibendum eros est eget nisi. Pellentesque fermentum varius nibh ac auctor. Aenean dictum lacus eu mauris eleifend imperdiet. Donec ornare nibh tristique lorem dapibus dapibus. Pellentesque habitant morbi tristique senectus et netus et malesuada fames ac turpis egestas. Curabitur tincidunt dui at tortor efficitur, nec condimentum purus lacinia. Morbi lectus mauris, mollis ac pharetra eget, laoreet ac tellus. Sed in orci non turpis auctor scelerisque sit amet vitae dolor. Nam hendrerit feugiat nibh vel facilisis.Aenean ac odio ipsum. In sed velit orci. Aliquam hendrerit, mauris blandit suscipit mollis, odio mi sagittis ante, vitae bibendum eros est eget nisi. Pellentesque fermentum varius nibh ac auctor. Aenean dictum lacus eu mauris eleifend imperdiet. Donec ornare nibh tristique lorem dapibus dapibus. Pellentesque habitant morbi tristique senectus et netus et malesuada fames ac turpis egestas. Curabitur tincidunt dui at tortor efficitur, nec condimentum purus lacinia. Morbi lectus mauris, mollis ac pharetra eget, laoreet ac tellus. Sed in orci non turpis auctor scelerisque sit amet vitae dolor. Nam hendrerit feugiat nibh vel facilisis.Aenean ac odio ipsum. In sed velit orci. Aliquam hendrerit, mauris blandit suscipit mollis, odio mi sagittis ante, vitae bibendum eros est eget nisi. Pellentesque fermentum varius nibh ac auctor. Aenean dictum lacus eu mauris eleifend imperdiet. Donec ornare nibh tristique lorem dapibus dapibus. Pellentesque habitant morbi tristique senectus et netus et malesuada fames ac turpis egestas. Curabitur tincidunt dui at tortor efficitur, nec condimentum purus lacinia. Morbi lectus mauris, mollis ac pharetra eget, laoreet ac tellus. Sed in orci non turpis auctor scelerisque sit amet vitae dolor. Nam hendrerit feugiat nibh vel facilisis.",
      },
    ],
  },
  {
    id: "2",
    role: "user",
    parts: [
      {
        type: "text",
        text: "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed ornare hendrerit interdum. Maecenas ullamcorper turpis nisl, ut lacinia neque semper placerat. Sed hendrerit, nulla ut fermentum dignissim, turpis eros ornare mauris, id auctor leo tortor pulvinar felis. Vestibulum leo nisi, venenatis vitae magna in, malesuada scelerisque felis. Etiam luctus massa justo, vitae euismod urna tincidunt et. Donec lectus libero, varius semper quam eget, venenatis convallis neque. Ut eu dui sed dolor vehicula convallis ut et leo. Nulla tempus sagittis ultrices. Maecenas a augue non leo eleifend porttitor. Maecenas pharetra id leo sit amet ullamcorper. Maecenas quis commodo erat. Cras sit amet tincidunt nisi. Vestibulum maximus dapibus egestas.",
      },
    ],
  },
  {
    id: "3",
    role: "assistant",
    parts: [
      {
        type: "text",
        text: "Aenean ac odio ipsum. In sed velit orci. Aliquam hendrerit, mauris blandit suscipit mollis, odio mi sagittis ante, vitae bibendum eros est eget nisi. Pellentesque fermentum varius nibh ac auctor. Aenean dictum lacus eu mauris eleifend imperdiet. Donec ornare nibh tristique lorem dapibus dapibus. Pellentesque habitant morbi tristique senectus et netus et malesuada fames ac turpis egestas. Curabitur tincidunt dui at tortor efficitur, nec condimentum purus lacinia. Morbi lectus mauris, mollis ac pharetra eget, laoreet ac tellus. Sed in orci non turpis auctor scelerisque sit amet vitae dolor. Nam hendrerit feugiat nibh vel facilisis.Aenean ac odio ipsum. In sed velit orci. Aliquam hendrerit, mauris blandit suscipit mollis, odio mi sagittis ante, vitae bibendum eros est eget nisi. Pellentesque fermentum varius nibh ac auctor. Aenean dictum lacus eu mauris eleifend imperdiet. Donec ornare nibh tristique lorem dapibus dapibus. Pellentesque habitant morbi tristique senectus et netus et malesuada fames ac turpis egestas. Curabitur tincidunt dui at tortor efficitur, nec condimentum purus lacinia. Morbi lectus mauris, mollis ac pharetra eget, laoreet ac tellus. Sed in orci non turpis auctor scelerisque sit amet vitae dolor. Nam hendrerit feugiat nibh vel facilisis.Aenean ac odio ipsum. In sed velit orci. Aliquam hendrerit, mauris blandit suscipit mollis, odio mi sagittis ante, vitae bibendum eros est eget nisi. Pellentesque fermentum varius nibh ac auctor. Aenean dictum lacus eu mauris eleifend imperdiet. Donec ornare nibh tristique lorem dapibus dapibus. Pellentesque habitant morbi tristique senectus et netus et malesuada fames ac turpis egestas. Curabitur tincidunt dui at tortor efficitur, nec condimentum purus lacinia. Morbi lectus mauris, mollis ac pharetra eget, laoreet ac tellus. Sed in orci non turpis auctor scelerisque sit amet vitae dolor. Nam hendrerit feugiat nibh vel facilisis.",
      },
    ],
  },
];

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
    // setStatus("submitted");
    // console.log("Submitting message:", message);
    // setTimeout(() => {
    //   setStatus("streaming");
    // }, SUBMITTING_TIMEOUT);
    // setTimeout(() => {
    //   setStatus("ready");
    // }, STREAMING_TIMEOUT);
  };

  return (
    <div className="relative flex size-full flex-col divide-y overflow-hidden h-[calc(100vh-44px)]">
      <Conversation className="overflow-y-hidden" data-conversation>
        <ConversationContent data-ccontent>
          {TEST_MESSAGES.map((message) => (
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
                          (m) => m.id === message.id
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
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>
      <div className="grid shrink-0 gap-4 pt-4">
        <PromptInputProvider>
          <PromptInput globalDrop multiple onSubmit={handleSubmit}>
            <PromptInputHeader>
              <PromptInputAttachments>
                {(attachment) => <PromptInputAttachment data={attachment} />}
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
                <PromptInputModelSelect onValueChange={setModel} value={model}>
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
  );
};
