import { useCallback, useMemo, useState } from "react";
import { FileUIPart, UIMessage } from "ai";
import type { PromptInputMessage } from "@/components/ai-elements/prompt-input";
import type { TurnMessage } from "@/hooks/use-chat-turn";
import {
  messageAttachments,
  messageSandboxUploads,
  messageText,
} from "@/lib/message-parts";

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
 * Nothing is lost: the edited message and everything below it stay in the Chat
 * as an Alternative (ADR-0026), which the arrows reach again (#712). They leave
 * the screen, and the edit is sent as a fresh turn. What changed in issue #710
 * is that the message survives the round trip whole: it opens from its parts
 * and resubmits with the attachments the surface hands back, rather than being
 * flattened to its text on the way in and rebuilt from a bare string on the way
 * out.
 *
 * Starting that turn is `resend`'s business (issue #971): it truncates at
 * `truncateAt`, sends, and answers whether it did. A refused resend leaves the
 * surface open, so the user can fix what refused it and try again.
 */
export const useMessageEditing = <T extends UIMessage = UIMessage>(
  messages: T[],
  resend: (truncateAt: number, message: TurnMessage) => boolean,
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

      // A Sandbox upload records a past upload, so the edit keeps it as it
      // was: the surface never shows it, and nothing is uploaded again.
      const sandboxUploads = messageSandboxUploads(
        messages[messageIndex].parts,
      );

      // An edit emptied of its words, its files and its uploads would truncate
      // the transcript and send nothing in its place — the one edit with no way
      // back. Left open instead, so the user can see what they are about to do.
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
};
