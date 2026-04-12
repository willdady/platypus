"use client";

import { useState, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { format } from "date-fns";
import useSWR from "swr";
import type {
  KanbanCard,
  KanbanCardComment,
  KanbanColumn,
  KanbanLabel,
  KanbanCardAssignee,
  KanbanCardPriority,
} from "@platypus/schemas";
import { KANBAN_CARD_PRIORITIES } from "@platypus/schemas";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Trash2, Calendar as CalendarIcon, Check, Users } from "lucide-react";
import { cn, fetcher, getInitials, joinUrl } from "@/lib/utils";
import { useBackendUrl } from "@/app/client-context";
import { useAuth } from "@/components/auth-provider";
import { useIsMobile } from "@/hooks/use-mobile";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Calendar } from "@/components/ui/calendar";
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

import { ScrollArea } from "@/components/ui/scroll-area";

function AssigneePicker({
  user,
  agents,
  selectedAssignees,
  onToggle,
}: {
  user: { id: string; name: string; image?: string | null } | null;
  agents?: { id: string; name: string; avatarUrl?: string }[];
  selectedAssignees: KanbanCardAssignee[];
  onToggle: (type: "user" | "agent", id: string) => void;
}) {
  const isAssigned = (type: "user" | "agent", id: string) =>
    selectedAssignees.some((a) => a.type === type && a.id === id);
  const assigned = selectedAssignees[0] ?? null;
  let assignedName: string | null = null;
  let assignedImage: string | null = null;
  if (assigned) {
    if (assigned.type === "user" && user && user.id === assigned.id) {
      assignedName = user.name;
      assignedImage = user.image ?? null;
    } else if (assigned.type === "agent") {
      const agent = agents?.find((a) => a.id === assigned.id);
      if (agent) {
        assignedName = agent.name;
        assignedImage = agent.avatarUrl ?? null;
      }
    }
  }

  const [open, setOpen] = useState(false);

  const handleSelect = (type: "user" | "agent", id: string) => {
    onToggle(type, id);
    setOpen(false);
  };

  return (
    <div>
      <p className="text-xs font-medium text-muted-foreground mb-2">Assignee</p>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            className={cn(
              "w-full justify-start text-left font-normal px-3",
              !assigned && "text-muted-foreground",
            )}
          >
            {assigned && assignedName ? (
              <>
                <span className="relative flex size-5 shrink-0 overflow-hidden rounded-full">
                  {assignedImage ? (
                    <img
                      src={assignedImage}
                      alt={assignedName}
                      className="aspect-square size-full object-cover"
                    />
                  ) : (
                    <span className="flex size-full items-center justify-center rounded-full bg-muted-foreground/20 text-[8px]">
                      {getInitials(assignedName)}
                    </span>
                  )}
                </span>
                <span className="truncate">{assignedName}</span>
              </>
            ) : (
              <>
                <Users className="size-3.5" />
                Assign...
              </>
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-56 p-0" align="start">
          <ScrollArea className="max-h-64">
            <div className="p-1">
              {user && (
                <button
                  className={cn(
                    "flex items-center gap-2 w-full rounded-md px-2 py-1.5 text-sm hover:bg-muted transition-colors",
                  )}
                  onClick={() => handleSelect("user", user.id)}
                >
                  <Avatar className="size-5">
                    {user.image && (
                      <AvatarImage src={user.image} alt={user.name} />
                    )}
                    <AvatarFallback className="text-[8px]">
                      {getInitials(user.name)}
                    </AvatarFallback>
                  </Avatar>
                  <span className="truncate flex-1 text-left">{user.name}</span>
                  {isAssigned("user", user.id) && (
                    <Check className="size-3.5 text-primary shrink-0" />
                  )}
                </button>
              )}
              {agents?.map((agent) => (
                <button
                  key={agent.id}
                  className={cn(
                    "flex items-center gap-2 w-full rounded-md px-2 py-1.5 text-sm hover:bg-muted transition-colors",
                  )}
                  onClick={() => handleSelect("agent", agent.id)}
                >
                  <Avatar className="size-5">
                    {agent.avatarUrl && (
                      <AvatarImage src={agent.avatarUrl} alt={agent.name} />
                    )}
                    <AvatarFallback className="text-[8px]">
                      {getInitials(agent.name)}
                    </AvatarFallback>
                  </Avatar>
                  <span className="truncate flex-1 text-left">
                    {agent.name}
                  </span>
                  {isAssigned("agent", agent.id) && (
                    <Check className="size-3.5 text-primary shrink-0" />
                  )}
                </button>
              ))}
            </div>
          </ScrollArea>
        </PopoverContent>
      </Popover>
    </div>
  );
}

export function KanbanCardDialog({
  card,
  labels,
  columns,
  columnId: initialColumnId,
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
  columns: Pick<KanbanColumn, "id" | "name">[];
  columnId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (
    cardId: string,
    data: {
      title?: string;
      body?: string;
      labelIds?: string[];
      columnId?: string;
      assignees?: KanbanCardAssignee[];
      dueDate?: string | null;
      priority?: KanbanCardPriority;
    },
  ) => void;
  onDelete: (cardId: string) => void;
  orgId: string;
  workspaceId: string;
  boardId: string;
}) {
  const backendUrl = useBackendUrl();
  const { user } = useAuth();
  const isMobile = useIsMobile();

  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [selectedLabelIds, setSelectedLabelIds] = useState<string[]>([]);
  const [selectedColumnId, setSelectedColumnId] = useState<string | null>(null);
  const [selectedAssignees, setSelectedAssignees] = useState<
    KanbanCardAssignee[]
  >([]);
  const [selectedDueDate, setSelectedDueDate] = useState<string | null>(null);
  const [selectedPriority, setSelectedPriority] =
    useState<KanbanCardPriority>("none");
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

  // Fetch workspace agents for assignee picker
  const agentsUrl =
    backendUrl && user
      ? joinUrl(
          backendUrl,
          `/organizations/${orgId}/workspaces/${workspaceId}/agents`,
        )
      : null;
  const { data: agentsData } = useSWR<{
    results: {
      id: string;
      name: string;
      avatarUrl?: string;
    }[];
  }>(agentsUrl, fetcher);

  const enterEditing = (field: "title" | "body") => {
    setFocusField(field);
    setIsEditing(true);
  };

  useEffect(() => {
    if (card) {
      setTitle(card.title);
      setBody(card.body ?? "");
      setSelectedLabelIds(card.labelIds ?? []);
      setSelectedAssignees(card.assignees ?? []);
      setSelectedDueDate((card.dueDate as string) ?? null);
      setSelectedPriority(card.priority ?? "none");
      setSelectedColumnId(initialColumnId);
      setIsEditing(false);
      setNewCommentBody("");
      setEditingCommentId(null);
    }
  }, [card, initialColumnId]);

  if (!card) return null;

  const toggleLabel = (labelId: string) => {
    setSelectedLabelIds((prev) =>
      prev.includes(labelId)
        ? prev.filter((id) => id !== labelId)
        : [...prev, labelId],
    );
  };

  const toggleAssignee = (type: "user" | "agent", id: string) => {
    setSelectedAssignees((prev) => {
      const exists = prev.some((a) => a.type === type && a.id === id);
      if (exists) return [];
      return [{ type, id }];
    });
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
      <DialogContent
        className="sm:max-w-5xl max-h-[90vh] flex flex-col"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <DialogHeader className="shrink-0">
          <DialogTitle>&nbsp;</DialogTitle>
        </DialogHeader>
        {isMobile ? (
          <Tabs defaultValue="details" className="min-h-0 flex-1 flex flex-col">
            <TabsList className="shrink-0">
              <TabsTrigger value="details">Details</TabsTrigger>
              <TabsTrigger value="comments">Comments</TabsTrigger>
            </TabsList>
            <TabsContent
              value="details"
              className="flex-1 overflow-y-auto space-y-4 mt-0 pt-4"
            >
              <div
                className="space-y-4"
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
              </div>

              <div className="border-t pt-4 space-y-4">
                {columns.length > 1 && selectedColumnId && (
                  <div>
                    <p className="text-xs font-medium text-muted-foreground mb-2">
                      Column
                    </p>
                    <Select
                      value={selectedColumnId}
                      onValueChange={setSelectedColumnId}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {columns.map((col) => (
                          <SelectItem key={col.id} value={col.id}>
                            {col.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
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

                {/* Priority */}
                <div>
                  <p className="text-xs font-medium text-muted-foreground mb-2">
                    Priority
                  </p>
                  <Select
                    value={selectedPriority}
                    onValueChange={(v) =>
                      setSelectedPriority(v as KanbanCardPriority)
                    }
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {KANBAN_CARD_PRIORITIES.map((p) => (
                        <SelectItem key={p.value} value={p.value}>
                          <div className="flex items-center gap-2">
                            {p.color && (
                              <span
                                className="size-2 rounded-full shrink-0"
                                style={{ backgroundColor: p.color }}
                              />
                            )}
                            <span>{p.label}</span>
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {/* Due Date */}
                <div>
                  <p className="text-xs font-medium text-muted-foreground mb-2">
                    Due Date
                  </p>
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button
                        variant="outline"
                        className={cn(
                          "w-full justify-start text-left font-normal",
                          !selectedDueDate && "text-muted-foreground",
                        )}
                      >
                        <CalendarIcon className="size-3.5" />
                        {selectedDueDate
                          ? format(new Date(selectedDueDate), "MMM d, yyyy")
                          : "Set due date"}
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-auto p-0" align="start">
                      <Calendar
                        mode="single"
                        selected={
                          selectedDueDate
                            ? new Date(selectedDueDate)
                            : undefined
                        }
                        onSelect={(date) =>
                          setSelectedDueDate(date ? date.toISOString() : null)
                        }
                      />
                    </PopoverContent>
                  </Popover>
                </div>

                {/* Assignees */}
                <AssigneePicker
                  user={user}
                  agents={agentsData?.results}
                  selectedAssignees={selectedAssignees}
                  onToggle={toggleAssignee}
                />

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
            </TabsContent>
            <TabsContent
              value="comments"
              className="flex-1 overflow-y-auto mt-0 pt-4"
            >
              <div>
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
            </TabsContent>
          </Tabs>
        ) : (
          <div className="flex flex-row gap-2 min-h-0 flex-1 overflow-hidden">
            {/* Main content - Title, Body, and Comments */}
            <div
              className="flex-1 min-w-0 space-y-4 overflow-y-auto pr-6"
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

            {/* Sidebar - Column, Labels, Assignees, Due Date, Priority, and Metadata */}
            <div className="w-52 shrink-0 space-y-4 overflow-y-auto">
              {columns.length > 1 && selectedColumnId && (
                <div>
                  <p className="text-xs font-medium text-muted-foreground mb-2">
                    Column
                  </p>
                  <Select
                    value={selectedColumnId}
                    onValueChange={setSelectedColumnId}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {columns.map((col) => (
                        <SelectItem key={col.id} value={col.id}>
                          {col.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
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

              {/* Priority */}
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-2">
                  Priority
                </p>
                <Select
                  value={selectedPriority}
                  onValueChange={(v) =>
                    setSelectedPriority(v as KanbanCardPriority)
                  }
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {KANBAN_CARD_PRIORITIES.map((p) => (
                      <SelectItem key={p.value} value={p.value}>
                        <div className="flex items-center gap-2">
                          {p.color && (
                            <span
                              className="size-2 rounded-full shrink-0"
                              style={{ backgroundColor: p.color }}
                            />
                          )}
                          <span>{p.label}</span>
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Due Date */}
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-2">
                  Due Date
                </p>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      className={cn(
                        "w-full justify-start text-left font-normal",
                        !selectedDueDate && "text-muted-foreground",
                      )}
                    >
                      <CalendarIcon className="size-3.5" />
                      {selectedDueDate
                        ? format(new Date(selectedDueDate), "MMM d, yyyy")
                        : "Set due date"}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="start">
                    <Calendar
                      mode="single"
                      selected={
                        selectedDueDate ? new Date(selectedDueDate) : undefined
                      }
                      onSelect={(date) =>
                        setSelectedDueDate(date ? date.toISOString() : null)
                      }
                    />
                  </PopoverContent>
                </Popover>
              </div>

              {/* Assignees */}
              <AssigneePicker
                user={user}
                agents={agentsData?.results}
                selectedAssignees={selectedAssignees}
                onToggle={toggleAssignee}
              />

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
        )}
        <DialogFooter className="shrink-0">
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="secondary">
                <Trash2 className="h-4 w-4" />
                Delete
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-4">
              <p className="text-sm mb-3">Delete this card?</p>
              <Button
                variant="destructive"
                size="sm"
                className="w-full"
                onClick={() => onDelete(card.id)}
              >
                Delete
              </Button>
            </PopoverContent>
          </Popover>
          <Button
            onClick={() =>
              onSave(card.id, {
                title,
                body,
                labelIds: selectedLabelIds,
                assignees: selectedAssignees,
                dueDate: selectedDueDate,
                priority: selectedPriority,
                ...(selectedColumnId &&
                  selectedColumnId !== initialColumnId && {
                    columnId: selectedColumnId,
                  }),
              })
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
