import { useCallback, useMemo, useState } from "react";
import { FileUIPart, UIMessage } from "ai";
import {
  ATTACHMENTS_ONLY_TEXT,
  messageAttachments,
  messageText,
} from "@/lib/message-parts";

/** What an edit resubmits: the whole message, not just its words. */
export type EditedMessage = {
  text: string;
  files?: FileUIPart[];
};

/**
 * The message an edit surface should open with. `null` when nothing is being
 * edited, or when the named message has left the transcript — a run that
 * hydrated a fresh snapshot underneath an open editor, say.
 */
export type MessageBeingEdited = {
  messageId: string;
  text: string;
  attachments: FileUIPart[];
};

/**
 * Editing a message: which one, what the surface opens holding, and what
 * resubmitting does to the transcript.
 *
 * Editing stays destructive — the edited message and everything below it goes,
 * and the edit is sent as a fresh turn. What changed in issue #710 is that the
 * message survives the round trip whole: it opens from its parts and resubmits
 * with the attachments the surface hands back, rather than being flattened to
 * its text on the way in and rebuilt from a bare string on the way out.
 */
export const useMessageEditing = <T extends UIMessage = UIMessage>(
  messages: T[],
  setMessages: (messages: T[]) => void,
  sendMessage: (
    message: EditedMessage,
    options?: { body?: Record<string, unknown> },
  ) => void,
  getRequestBody: () => Record<string, unknown>,
) => {
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
    (edited: EditedMessage) => {
      if (!editingMessageId) return;
      const messageIndex = messages.findIndex((m) => m.id === editingMessageId);
      if (messageIndex === -1) return;

      const files = edited.files ?? [];
      // An edit emptied of both its words and its files would truncate the
      // transcript and send nothing in its place — the one edit with no way
      // back. Left open instead, so the user can see what they are about to do.
      if (!edited.text && files.length === 0) return;

      // Remove the edited message and everything after it
      setMessages(messages.slice(0, messageIndex));

      sendMessage(
        { text: edited.text || ATTACHMENTS_ONLY_TEXT, files },
        { body: getRequestBody() },
      );

      setEditingMessageId(null);
    },
    [editingMessageId, getRequestBody, messages, sendMessage, setMessages],
  );

  return {
    editing,
    handleMessageEditStart,
    handleMessageEditCancel,
    handleMessageEditSubmit,
  };
};
