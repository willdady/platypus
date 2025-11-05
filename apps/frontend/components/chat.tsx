"use client";

import { Action, Actions } from "@/components/ui/shadcn-io/ai/actions";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ui/shadcn-io/ai/conversation";
import { Message, MessageContent } from "@/components/ui/shadcn-io/ai/message";
import {
  PromptInput,
  PromptInputModelSelect,
  PromptInputModelSelectContent,
  PromptInputModelSelectItem,
  PromptInputModelSelectTrigger,
  PromptInputModelSelectValue,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputToolbar,
  PromptInputTools,
} from "@/components/ui/shadcn-io/ai/prompt-input";
import { Response } from "@/components/ui/shadcn-io/ai/response";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { CopyIcon, TrashIcon } from "lucide-react";
import { useState, useEffect } from "react";
import { Model } from "@agent-kit/schemas";

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL;

export const Chat = ({ orgId, workspaceId }: { orgId: string; workspaceId: string }) => {
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

  return (
    <div className="flex flex-col size-full items-center">
      <Conversation className="flex-none w-full h-[calc(100vh-44px-110px-1.5rem)]">
        <ConversationContent className="h-full flex justify-center">
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
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      <PromptInput
        className="w-full xl:w-3/5"
        onSubmit={(e) => {
          e.preventDefault();
          if (input.trim()) {
            sendMessage({ text: input });
            setInput("");
          }
        }}
      >
        <PromptInputTextarea
          onChange={(e) => setInput(e.target.value)}
          value={input}
          placeholder="Type your message..."
        />
        <PromptInputToolbar>
          <PromptInputTools>
            <PromptInputModelSelect onValueChange={setModel} value={model}>
              <PromptInputModelSelectTrigger>
                <PromptInputModelSelectValue />
              </PromptInputModelSelectTrigger>
              <PromptInputModelSelectContent>
                {models.map((model) => (
                  <PromptInputModelSelectItem key={model.id} value={model.id}>
                    {model.name}
                  </PromptInputModelSelectItem>
                ))}
              </PromptInputModelSelectContent>
            </PromptInputModelSelect>
          </PromptInputTools>
          <PromptInputSubmit disabled={!input} status={status} />
        </PromptInputToolbar>
      </PromptInput>
    </div>
  );
};
