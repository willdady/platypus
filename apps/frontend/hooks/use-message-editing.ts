import { useState, useRef, useEffect } from "react";
import { UIMessage } from "ai";

export const useMessageEditing = <T extends UIMessage = UIMessage>(
  messages: T[],
  setMessages: (messages: T[]) => void,
  sendMessage: (message: { text: string }, options?: { body?: any }) => void,
  getRequestBody: () => any,
) => {
  const editTextareaRef = useRef<HTMLTextAreaElement>(null);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState("");

  // Select all text in edit textarea when editing starts
  useEffect(() => {
    if (editingMessageId && editTextareaRef.current) {
      editTextareaRef.current.select();
    }
  }, [editingMessageId]);

  const handleMessageEditStart = (messageId: string, content: string) => {
    setEditingMessageId(messageId);
    setEditContent(content);
  };

  const handleMessageEditCancel = () => {
    setEditingMessageId(null);
    setEditContent("");
  };

  const handleMessageEditSubmit = () => {
    if (!editingMessageId) return;
    const messageIndex = messages.findIndex((m) => m.id === editingMessageId);
    if (messageIndex === -1) return;

    // Remove messages after this one (including this one)
    const newMessages = messages.slice(0, messageIndex);
    setMessages(newMessages);

    // Submit the edited message to backend (will append it)
    const body = getRequestBody();
    sendMessage({ text: editContent }, { body });

    // Reset edit state
    setEditingMessageId(null);
    setEditContent("");
  };

  return {
    editTextareaRef,
    editingMessageId,
    editContent,
    setEditContent,
    handleMessageEditStart,
    handleMessageEditCancel,
    handleMessageEditSubmit,
  };
};
