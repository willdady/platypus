"use client";

import { useState, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import useSWR from "swr";
import type { KanbanCard, KanbanCardComment, KanbanLabel } from "@platypus/schemas";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Trash2 } from "lucide-react";
import { cn, fetcher, joinUrl } from "@/lib/utils";
import { useBackendUrl } from "@/app/client-context";
import { useAuth } from "@/components/auth-provider";
import { toast } from "sonner";

function formatRelativeTime(date: Date): string {
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return date.toLocaleDateString();
}

export function KanbanCardDialog({
  card,
  labels,
  open,
  onOpenChange,
  onSave,
  onDelete,
  orgId,
  workspaceId,
  boardId,
}: {
  card: KanbanCard | null;
  labels: KanbanLabel[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (
    cardId: string,
    data: { title?: string; body?: string; labelIds?: string[] },
  ) => void;
  onDelete: (cardId: string) => void;
  orgId: string;
  workspaceId: string;
  boardId: string;
}) {
  const backendUrl = useBackendUrl();
  const { user } = useAuth();

  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [selectedLabelIds, setSelectedLabelIds] = useState<string[]>([]);
  const [isEditing, setIsEditing] = useState(false);
  const [focusField, setFocusField] = useState<"title" | "body">("title");

  const [newCommentBody, setNewCommentBody] = useState("");
  const [editingCommentId, setEditingCommentId] = useState<string | null>(null);
  const [editingCommentBody, setEditingCommentBody] = useState("");

  const commentsUrl =
    backendUrl && user && card
      ? joinUrl(
          backendUrl,
          `/organizations/${orgId}/workspaces/${workspaceId}/boards/${boardId}/cards/${card.id}/comments`,
        )
      : null;

  const { data: commentsData, mutate: mutateComments } = useSWR<{
    results: KanbanCardComment[];
  }>(commentsUrl, fetcher);

  const comments = commentsData?.results ?? [];

  const enterEditing = (field: "title" | "body") => {
    setFocusField(field);
    setIsEditing(true);
  };

  useEffect(() => {
    if (card) {
      setTitle(card.title);
      setBody(card.body ?? "");
      setSelectedLabelIds(card.labelIds ?? []);
      setIsEditing(false);
      setNewCommentBody("");
      setEditingCommentId(null);
    }
  }, [card]);

  if (!card) return null;

  const toggleLabel = (labelId: string) => {
    setSelectedLabelIds((prev) =>
      prev.includes(labelId)
        ? prev.filter((id) => id !== labelId)
        : [...prev, labelId],
    );
  };

  const handleAddComment = async () => {
    if (!newCommentBody.trim() || !commentsUrl) return;
    try {
      await fetch(commentsUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: newCommentBody.trim() }),
        credentials: "include",
      });
      setNewCommentBody("");
      await mutateComments();
    } catch {
      toast.error("Failed to add comment");
    }
  };

  const handleEditComment = async (commentId: string) => {
    if (!editingCommentBody.trim() || !commentsUrl) return;
    try {
      await fetch(joinUrl(commentsUrl, `/${commentId}`), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: editingCommentBody.trim() }),
        credentials: "include",
      });
      setEditingCommentId(null);
      setEditingCommentBody("");
      await mutateComments();
    } catch {
      toast.error("Failed to update comment");
    }
  };

  const handleDeleteComment = async (commentId: string) => {
    if (!commentsUrl) return;
    try {
      await fetch(joinUrl(commentsUrl, `/${commentId}`), {
        method: "DELETE",
        credentials: "include",
      });
      await mutateComments();
    } catch {
      toast.error("Failed to delete comment");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl max-h-[90vh] flex flex-col">
        <DialogHeader className="shrink-0">
          <DialogTitle>&nbsp;</DialogTitle>
        </DialogHeader>
        <div className="flex gap-4 min-h-0 flex-1">
          {/* Main content - Title, Body, and Comments */}
          <div
            className="flex-1 min-w-0 space-y-4 overflow-y-auto pr-3"
            onBlur={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget)) {
                setIsEditing(false);
              }
            }}
          >
            {isEditing ? (
              <Input
                autoFocus={focusField === "title"}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="text-lg font-semibold"
                placeholder="Card title"
              />
            ) : (
              <h2
                className="text-lg font-semibold cursor-pointer"
                onClick={() => enterEditing("title")}
              >
                {title}
              </h2>
            )}
            {isEditing ? (
              <Textarea
                autoFocus={focusField === "body"}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder="Add a description..."
                rows={6}
                className="min-h-[150px]"
              />
            ) : body ? (
              <div
                className="prose prose-sm dark:prose-invert max-w-none cursor-pointer min-h-[150px]"
                onClick={() => enterEditing("body")}
              >
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {body}
                </ReactMarkdown>
              </div>
            ) : (
              <p
                className="text-sm text-muted-foreground cursor-pointer min-h-[150px] hover:text-foreground"
                onClick={() => enterEditing("body")}
              >
                Click to add a description...
              </p>
            )}

            {/* Comments section */}
            <div className="border-t pt-4">
              <p className="text-sm font-medium mb-3">Comments</p>
              {comments.length > 0 && (
                <div className="space-y-3 mb-4">
                  {comments.map((comment) => (
                    <div key={comment.id} className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-medium">
                          {comment.createdByName ?? "Unknown"}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {formatRelativeTime(new Date(comment.createdAt))}
                        </span>
                      </div>
                      {editingCommentId === comment.id ? (
                        <div className="space-y-2">
                          <Textarea
                            value={editingCommentBody}
                            onChange={(e) =>
                              setEditingCommentBody(e.target.value)
                            }
                            rows={3}
                            autoFocus
                          />
                          <div className="flex gap-2">
                            <Button
                              size="sm"
                              onClick={() => handleEditComment(comment.id)}
                              disabled={!editingCommentBody.trim()}
                            >
                              Save
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => {
                                setEditingCommentId(null);
                                setEditingCommentBody("");
                              }}
                            >
                              Cancel
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <div className="prose prose-sm dark:prose-invert max-w-none">
                            <ReactMarkdown remarkPlugins={[remarkGfm]}>
                              {comment.body}
                            </ReactMarkdown>
                          </div>
                          <div className="flex gap-2">
                            <button
                              className="text-xs text-muted-foreground hover:text-foreground"
                              onClick={() => {
                                setEditingCommentId(comment.id);
                                setEditingCommentBody(comment.body);
                              }}
                            >
                              Edit
                            </button>
                            <Popover>
                              <PopoverTrigger asChild>
                                <button className="text-xs text-muted-foreground hover:text-destructive">
                                  Delete
                                </button>
                              </PopoverTrigger>
                              <PopoverContent className="w-auto p-4">
                                <p className="text-sm mb-3">
                                  Delete this comment?
                                </p>
                                <Button
                                  variant="destructive"
                                  size="sm"
                                  className="w-full"
                                  onClick={() =>
                                    handleDeleteComment(comment.id)
                                  }
                                >
                                  Delete
                                </Button>
                              </PopoverContent>
                            </Popover>
                          </div>
                        </>
                      )}
                    </div>
                  ))}
                </div>
              )}
              <div className="space-y-2">
                <Textarea
                  value={newCommentBody}
                  onChange={(e) => setNewCommentBody(e.target.value)}
                  placeholder="Add a comment..."
                  rows={3}
                />
                <Button
                  size="sm"
                  onClick={handleAddComment}
                  disabled={!newCommentBody.trim()}
                >
                  Comment
                </Button>
              </div>
            </div>
          </div>

          {/* Sidebar - Labels and Metadata */}
          <div className="w-48 shrink-0 space-y-4">
            {labels.length > 0 && (
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-2">
                  Labels
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {labels.map((label) => {
                    const isActive = selectedLabelIds.includes(label.id);
                    return (
                      <Badge
                        key={label.id}
                        className={cn(
                          "cursor-pointer transition-opacity border-0",
                          !isActive && "opacity-40",
                        )}
                        style={{ backgroundColor: label.color }}
                        onClick={() => toggleLabel(label.id)}
                      >
                        {label.name}
                      </Badge>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="text-xs text-muted-foreground space-y-1.5">
              {card.createdByName && (
                <p>
                  <span className="font-medium">Created by:</span>{" "}
                  {card.createdByName}
                </p>
              )}
              {card.lastEditedByName && (
                <p>
                  <span className="font-medium">Last edited by:</span>{" "}
                  {card.lastEditedByName}
                </p>
              )}
            </div>
          </div>
        </div>
        <DialogFooter className="shrink-0">
          <Button variant="secondary" onClick={() => onDelete(card.id)}>
            <Trash2 className="h-4 w-4" />
            Delete
          </Button>
          <Button
            onClick={() =>
              onSave(card.id, { title, body, labelIds: selectedLabelIds })
            }
            disabled={!title.trim()}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
