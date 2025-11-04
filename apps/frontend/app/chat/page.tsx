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
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputToolbar,
  PromptInputTools,
} from "@/components/ui/shadcn-io/ai/prompt-input";
import { Response } from "@/components/ui/shadcn-io/ai/response";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { CopyIcon, TrashIcon } from "lucide-react";
import { useState } from "react";

const Chat = () => {
  const { messages, setMessages, sendMessage, status } = useChat({
    transport: new DefaultChatTransport({
      api: "http://localhost:3999/chat",
    }),
  });
  const [input, setInput] = useState("");
  const [copied, setCopied] = useState(false);
  
  return (
    <div className="flex flex-col h-full">
      <Conversation className="flex-1">
        <ConversationContent>
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
                       tooltip={copied ? 'Copied!' : 'Copy (⌘C)'}
                       variant={copied ? 'secondary' : 'ghost'}
                       label="Copy"
                     >
                       <CopyIcon className="size-4" />
                     </Action>
                     <Action
                       onClick={() => {
                         const index = messages.findIndex(m => m.id === message.id);
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
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      <PromptInput
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
          <PromptInputTools></PromptInputTools>
          <PromptInputSubmit disabled={!input} status={status} />
        </PromptInputToolbar>
      </PromptInput>
    </div>
  );
};

export default Chat;
