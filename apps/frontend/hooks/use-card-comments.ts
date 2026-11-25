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
  readonly scope: Scope;
  readonly boardId: string;
  readonly cardId: string | null;
};

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
  readonly commentAction: string | null;
  readonly commentDeleting: boolean;
};

export type CardComments = {
  readonly sectionProps: CardCommentsSectionProps;
  readonly deleteDialogProps: DeleteDialogProps;
  readonly dirty: boolean;
  readonly reset: () => void;
  readonly deleteTrigger: () => HTMLElement | null;
};

// why: the dialog owns this, not the tabbed section, which unmounts and drops a draft
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

  const commentsEntity = `boards/${boardId}/cards/${cardId ?? ""}/comments`;
  const { results: comments, mutate: mutateComments } =
    useScopedList<KanbanCardComment>(commentsEntity, cardId ? scope : null);

  // why: one comment write at a time, so only its own button reads as pending
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
