import { useCallback, useMemo, useState } from "react";
import { FileUIPart, UIMessage } from "ai";
import type { PromptInputMessage } from "@/components/ai-elements/prompt-input";
import { messageAttachments, messageText } from "@/lib/message-parts";

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
 * Editing a message: which one, and what the surface opens holding.
 *
 * Storage is no longer destructive: the edited message and everything below
 * it stay in the Chat as an Alternative (ADR-0026). The screen still is, until
 * there is a way to reach Alternatives (#712) — the edited message and
 * everything below it leave the transcript, and the edit is sent as a fresh
 * turn. What changed in issue #710 is that the message survives the round trip
 * whole: it opens from its parts and resubmits with the attachments the surface
 * hands back, rather than being flattened to its text on the way in and rebuilt
 * from a bare string on the way out.
 *
 * Starting that turn is `resend`'s business (issue #971): it truncates at
 * `truncateAt`, sends, and answers whether it did. A refused resend leaves the
 * surface open, so the user can fix what refused it and try again.
 */
export const useMessageEditing = <T extends UIMessage = UIMessage>(
  messages: T[],
  resend: (truncateAt: number, message: PromptInputMessage) => boolean,
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
    (edited: PromptInputMessage) => {
      if (!editingMessageId) return;
      const messageIndex = messages.findIndex((m) => m.id === editingMessageId);
      if (messageIndex === -1) return;

      // An edit emptied of both its words and its files would truncate the
      // transcript and send nothing in its place — the one edit with no way
      // back. Left open instead, so the user can see what they are about to do.
      if (!edited.text && edited.files.length === 0) return;

      if (resend(messageIndex, edited)) setEditingMessageId(null);
    },
    [editingMessageId, messages, resend],
  );

  return {
    editing,
    handleMessageEditStart,
    handleMessageEditCancel,
    handleMessageEditSubmit,
  };
};
