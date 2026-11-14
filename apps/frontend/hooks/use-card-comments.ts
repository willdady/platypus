import { useRef, useState } from "react";
import { toast } from "sonner";
import type { KanbanCardComment } from "@platypus/schemas";
import { useBackendUrl } from "@/components/auth-provider";
import { useDeleteFlow, type DeleteDialogProps } from "@/hooks/use-delete-flow";
import { useMutation } from "@/hooks/use-mutation";
import { useScopedList } from "@/hooks/use-scoped-list";
import {
  writeEntity,
  type Scope,
  type Serialized,
  type WriteOptions,
} from "@/lib/api-write";

type SerializedComment = Serialized<KanbanCardComment>;

export type CardCommentsOptions = {
  /** The Organization and Workspace the card's board lives in. */
  readonly scope: Scope;
  readonly boardId: string;
  /** The card whose thread is read, or null while no card is open. */
  readonly cardId: string | null;
};

/** The comments section's props, minus the `className` each layout gives it. */
export type CardCommentsSectionProps = {
  readonly comments: SerializedComment[];
  readonly newCommentBody: string;
  readonly onNewCommentBodyChange: (body: string) => void;
  readonly editingCommentId: string | null;
  readonly editingCommentBody: string;
  readonly onEditingCommentBodyChange: (body: string) => void;
  readonly onAddComment: () => void;
  readonly onSaveComment: (commentId: string) => void;
  readonly onDeleteComment: (
    comment: SerializedComment,
    trigger: HTMLElement | null,
  ) => void;
  readonly onStartEditComment: (comment: SerializedComment) => void;
  readonly onCancelEditComment: () => void;
  /**
   * The comment write in flight — `add` or `edit:<id>` — or null. Every
   * comment button waits for it; only its own reads as pending.
   */
  readonly commentAction: string | null;
  /** A comment delete is running in its confirm dialog. */
  readonly commentDeleting: boolean;
};

export type CardComments = {
  /** Props for the comments section, wherever the layout places it. */
  readonly sectionProps: CardCommentsSectionProps;
  /** The comment delete confirm's props, ready to spread. */
  readonly deleteDialogProps: DeleteDialogProps;
  /** A draft or an edit is open, so the card dialog is dirty. */
  readonly dirty: boolean;
  /** Clears the draft and any edit in progress. */
  readonly reset: () => void;
  /**
   * The button the comment delete confirm was opened from, while it is still
   * in the document. A comment's own Delete goes away with the comment it
   * deleted, so the dialog has a fallback of its own for that case.
   */
  readonly deleteTrigger: () => HTMLElement | null;
};

/**
 * A card's comment thread: its read, the draft and the edit being typed, the
 * add and edit writes, and the delete confirm (#1948).
 *
 * The dialog calls this above its layouts rather than the comments section
 * calling it, because the tabbed layout unmounts the tab it leaves — a draft
 * kept inside the section would go with it. The thread is deliberately not
 * reset when the open card is updated server-side: a comment is not derived
 * from the card's fields. `reset` is the caller's to run when the dialog shows
 * a different card or closes.
 */
export function useCardComments({
  scope,
  boardId,
  cardId,
}: CardCommentsOptions): CardComments {
  const backendUrl = useBackendUrl();
  const deleteTriggerRef = useRef<HTMLElement | null>(null);
  const [newCommentBody, setNewCommentBody] = useState("");
  const [editingCommentId, setEditingCommentId] = useState<string | null>(null);
  const [editingCommentBody, setEditingCommentBody] = useState("");
  const [commentAction, setCommentAction] = useState<string | null>(null);

  // The thread's key, shared by its read and its delete so the two can't drift
  // onto different spellings. No card yet means nothing is read.
  const commentsEntity = `boards/${boardId}/cards/${cardId ?? ""}/comments`;
  const { results: comments, mutate: mutateComments } =
    useScopedList<KanbanCardComment>(commentsEntity, cardId ? scope : null);

  // One comment write at a time, whichever it is: `action` names the one in
  // flight so only its own button reads as pending.
  const commentWrite = useMutation(
    async (action: string, write: () => Promise<void>) => {
      setCommentAction(action);
      try {
        await write();
      } finally {
        setCommentAction(null);
      }
    },
  );

  // A refused comment delete stays in its dialog, and a successful one
  // revalidates the thread so the comment disappears.
  const commentDelete = useDeleteFlow<SerializedComment>({
    delete: (comment, url) =>
      writeEntity(url, commentsEntity, scope, { id: comment.id }),
    mutate: mutateComments,
  });

  const cancelEditing = () => {
    setEditingCommentId(null);
    setEditingCommentBody("");
  };

  const reset = () => {
    setNewCommentBody("");
    cancelEditing();
  };

  // The button a comment's Delete confirm was opened from, for the dialog to
  // put focus back on when it closes.
  const deleteTrigger = () =>
    deleteTriggerRef.current?.isConnected ? deleteTriggerRef.current : null;

  const startEditing = (comment: SerializedComment) => {
    setEditingCommentId(comment.id);
    setEditingCommentBody(comment.body);
  };

  const requestDelete = (
    comment: SerializedComment,
    trigger: HTMLElement | null,
  ) => {
    deleteTriggerRef.current = trigger;
    commentDelete.request(comment);
  };

  // One comment write. A refusal keeps the text it was written from and shows
  // the backend's reason; a success clears that text and revalidates the
  // thread so the comment arrives or shows its edit.
  const writeComment = (
    action: string,
    options: WriteOptions,
    onSuccess: () => void,
  ) =>
    void commentWrite.run(action, async () => {
      if (!backendUrl) return;
      const outcome = await writeEntity(
        backendUrl,
        commentsEntity,
        scope,
        options,
      );
      if (outcome.outcome !== "success") {
        toast.error(outcome.message);
        return;
      }
      onSuccess();
      await mutateComments();
    });

  const addComment = () => {
    if (!newCommentBody.trim()) return;
    writeComment("add", { data: { body: newCommentBody.trim() } }, () =>
      setNewCommentBody(""),
    );
  };

  const saveComment = (commentId: string) => {
    if (!editingCommentBody.trim()) return;
    writeComment(
      `edit:${commentId}`,
      {
        id: commentId,
        method: "PATCH",
        data: { body: editingCommentBody.trim() },
      },
      cancelEditing,
    );
  };

  return {
    sectionProps: {
      comments,
      newCommentBody,
      onNewCommentBodyChange: setNewCommentBody,
      editingCommentId,
      editingCommentBody,
      onEditingCommentBodyChange: setEditingCommentBody,
      onAddComment: addComment,
      onSaveComment: saveComment,
      onDeleteComment: requestDelete,
      onStartEditComment: startEditing,
      onCancelEditComment: cancelEditing,
      commentAction,
      commentDeleting: commentDelete.deleting,
    },
    deleteDialogProps: commentDelete.dialogProps,
    dirty: newCommentBody.trim() !== "" || editingCommentId !== null,
    reset,
    deleteTrigger,
  };
}
