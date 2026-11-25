import { useCallback, useMemo, useState } from "react";
import type { FileUIPart, UIMessage } from "ai";
import type { PromptInputMessage } from "@/components/ai-elements/prompt-input";
import type { TurnMessage } from "@/hooks/use-chat-turn";
import {
  messageAttachments,
  messageSandboxUploads,
  messageText,
} from "@/lib/message-parts";

export type MessageBeingEdited = {
  messageId: string;
  text: string;
  attachments: FileUIPart[];
};

export function useMessageEditing<T extends UIMessage = UIMessage>(
  messages: T[],
  resend: (truncateAt: number, message: TurnMessage) => boolean,
) {
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);

  const editing = useMemo<MessageBeingEdited | null>(() => {
    if (!editingMessageId) return null;
    const message = messages.find((m) => m.id === editingMessageId);
    if (!message) return null;
    return {
      messageId: message.id,
      text: messageText(message.parts),
      attachments: messageAttachments(message.parts),
    };
  }, [editingMessageId, messages]);

  const handleMessageEditStart = useCallback((messageId: string) => {
    setEditingMessageId(messageId);
  }, []);

  const handleMessageEditCancel = useCallback(() => {
    setEditingMessageId(null);
  }, []);

  const handleMessageEditSubmit = useCallback(
    (edited: PromptInputMessage) => {
      if (!editingMessageId) return;
      const messageIndex = messages.findIndex((m) => m.id === editingMessageId);
      if (messageIndex === -1) return;

      const sandboxUploads = messageSandboxUploads(
        messages[messageIndex].parts,
      );

      if (!edited.text && edited.files.length === 0 && !sandboxUploads.length)
        return;

      const message = sandboxUploads.length
        ? { ...edited, sandboxUploads }
        : edited;
      if (resend(messageIndex, message)) setEditingMessageId(null);
    },
    [editingMessageId, messages, resend],
  );

  return {
    editing,
    handleMessageEditStart,
    handleMessageEditCancel,
    handleMessageEditSubmit,
  };
}
