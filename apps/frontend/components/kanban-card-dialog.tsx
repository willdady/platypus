"use client";

import { useState, type FocusEventHandler, type ReactNode } from "react";
import { useResetOnChange } from "@/hooks/use-reset-on-change";
import { Markdown } from "@/components/markdown";
import { format } from "date-fns";
import { useScopedSWR } from "@/hooks/use-scoped-swr";
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Trash2,
  Calendar as CalendarIcon,
  Check,
  Users,
  User,
  Pencil,
  Copy,
  Link2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { writeEntity } from "@/lib/api-write";
import { formatRelativeTime } from "@/lib/relative-time";
import { useAuth, useBackendUrl } from "@/components/auth-provider";
import { useIsMobile } from "@/hooks/use-mobile";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { AgentAvatar } from "@/components/agent-avatar";
import { KanbanCardHistory } from "@/components/kanban-card-history";
import { Calendar } from "@/components/ui/calendar";
import { toast } from "sonner";

type CardSaveData = {
  title?: string;
  body?: string;
  labelIds?: string[];
  columnId?: string;
  assignees?: KanbanCardAssignee[];
  dueDate?: string | null;
  priority?: KanbanCardPriority;
};

type AgentOption = { id: string; name: string; avatarUrl?: string };

function AssigneePicker({
  user,
  agents,
  selectedAssignees,
  onToggle,
}: {
  user: { id: string; name: string; image?: string | null } | null;
  agents?: AgentOption[];
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

  return (
    <div>
      <p className="text-xs font-medium text-muted-foreground mb-2">Assignee</p>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            className={cn(
              "w-full justify-start text-left font-normal px-3",
              !assigned && "text-muted-foreground",
            )}
          >
            {assigned && assignedName ? (
              <>
                {assigned.type === "agent" ? (
                  <AgentAvatar
                    agent={{
                      name: assignedName,
                      avatarUrl: assignedImage ?? undefined,
                    }}
                    className="size-5"
                  />
                ) : (
                  <Avatar className="size-5">
                    {assignedImage && (
                      <AvatarImage src={assignedImage} alt={assignedName} />
                    )}
                    <AvatarFallback>
                      <User className="size-3 text-muted-foreground" />
                    </AvatarFallback>
                  </Avatar>
                )}
                <span className="truncate">{assignedName}</span>
              </>
            ) : (
              <>
                <Users className="size-3.5" />
                Assign...
              </>
            )}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-56" align="start">
          {user && (
            <>
              <DropdownMenuLabel>Users</DropdownMenuLabel>
              <DropdownMenuItem onSelect={() => onToggle("user", user.id)}>
                <Avatar className="size-5">
                  {user.image && (
                    <AvatarImage src={user.image} alt={user.name} />
                  )}
                  <AvatarFallback>
                    <User className="size-3 text-muted-foreground" />
                  </AvatarFallback>
                </Avatar>
                <span className="truncate flex-1">{user.name}</span>
                {isAssigned("user", user.id) && (
                  <Check className="size-3.5 shrink-0" />
                )}
              </DropdownMenuItem>
            </>
          )}
          {user && agents && agents.length > 0 && <DropdownMenuSeparator />}
          {agents && agents.length > 0 && (
            <DropdownMenuLabel>Agents</DropdownMenuLabel>
          )}
          {agents?.map((agent) => (
            <DropdownMenuItem
              key={agent.id}
              onSelect={() => onToggle("agent", agent.id)}
            >
              <AgentAvatar agent={agent} className="size-5" />
              <span className="truncate flex-1">{agent.name}</span>
              {isAssigned("agent", agent.id) && (
                <Check className="size-3.5 shrink-0" />
              )}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

// Rendered next to the card title in both the mobile and desktop layouts.
function CardTitleActions({
  onCopyLink,
  onCopyMarkdown,
  onEdit,
}: {
  onCopyLink: () => void;
  onCopyMarkdown: () => void;
  onEdit: () => void;
}) {
  return (
    <div className="flex items-center gap-0.5">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            aria-label="Copy link to card"
            onClick={onCopyLink}
          >
            <Link2 className="h-3.5 w-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Copy link to card</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            aria-label="Copy card as Markdown"
            onClick={onCopyMarkdown}
          >
            <Copy className="h-3.5 w-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Copy card as Markdown</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            aria-label="Edit card"
            onClick={onEdit}
          >
            <Pencil className="h-3.5 w-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Edit card</TooltipContent>
      </Tooltip>
    </div>
  );
}

// The title row: an inline editor while editing, otherwise the heading with
// its copy/edit actions. Shared by both layouts.
function CardTitleSection({
  title,
  isEditing,
  focusField,
  onTitleChange,
  onCopyLink,
  onCopyMarkdown,
  onEdit,
}: {
  title: string;
  isEditing: boolean;
  focusField: "title" | "body";
  onTitleChange: (title: string) => void;
  onCopyLink: () => void;
  onCopyMarkdown: () => void;
  onEdit: () => void;
}) {
  if (isEditing) {
    return (
      <Input
        autoFocus={focusField === "title"}
        value={title}
        onChange={(e) => onTitleChange(e.target.value)}
        className="text-xl font-semibold"
        placeholder="Card title"
      />
    );
  }
  return (
    <div className="flex items-center justify-between">
      <h1 className="text-xl font-semibold [overflow-wrap:anywhere]">
        {title}
      </h1>
      <CardTitleActions
        onCopyLink={onCopyLink}
        onCopyMarkdown={onCopyMarkdown}
        onEdit={onEdit}
      />
    </div>
  );
}

// The body editor: a textarea while editing, otherwise rendered markdown.
// Shared by both layouts.
function CardBodySection({
  body,
  isEditing,
  focusField,
  onBodyChange,
}: {
  body: string;
  isEditing: boolean;
  focusField: "title" | "body";
  onBodyChange: (body: string) => void;
}) {
  if (isEditing) {
    return (
      <Textarea
        autoFocus={focusField === "body"}
        value={body}
        onChange={(e) => onBodyChange(e.target.value)}
        placeholder="Add a description..."
        rows={6}
        className="min-h-[150px]"
      />
    );
  }
  return (
    <div className="min-h-[150px]">
      {body ? (
        <div className="[overflow-wrap:anywhere]">
          <Markdown>{body}</Markdown>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">No description.</p>
      )}
    </div>
  );
}

// The title/body pane. Mobile nests it in the details tab with the metadata
// below; desktop puts comments and history below it, with the metadata in a
// sibling sidebar. The container only differs by `className`.
function CardDetailsPane({
  className,
  title,
  body,
  isEditing,
  focusField,
  onTitleChange,
  onBodyChange,
  onCopyLink,
  onCopyMarkdown,
  onEdit,
  onBlur,
  children,
}: {
  className?: string;
  title: string;
  body: string;
  isEditing: boolean;
  focusField: "title" | "body";
  onTitleChange: (title: string) => void;
  onBodyChange: (body: string) => void;
  onCopyLink: () => void;
  onCopyMarkdown: () => void;
  onEdit: () => void;
  onBlur: FocusEventHandler<HTMLDivElement>;
  children: ReactNode;
}) {
  return (
    <div
      className={cn("flex flex-col min-h-0 flex-1", className)}
      onBlur={onBlur}
    >
      <div className="shrink-0 mb-4">
        <CardTitleSection
          title={title}
          isEditing={isEditing}
          focusField={focusField}
          onTitleChange={onTitleChange}
          onCopyLink={onCopyLink}
          onCopyMarkdown={onCopyMarkdown}
          onEdit={onEdit}
        />
      </div>
      <div className="flex-1 overflow-y-auto min-h-0 space-y-4">
        <CardBodySection
          body={body}
          isEditing={isEditing}
          focusField={focusField}
          onBodyChange={onBodyChange}
        />
        {children}
      </div>
    </div>
  );
}

// The comment list and composer. Shared by both layouts.
function CommentsSection({
  className,
  comments,
  newCommentBody,
  onNewCommentBodyChange,
  editingCommentId,
  editingCommentBody,
  onEditingCommentBodyChange,
  onAddComment,
  onSaveComment,
  onDeleteComment,
  onStartEditComment,
  onCancelEditComment,
}: {
  className?: string;
  comments: KanbanCardComment[];
  newCommentBody: string;
  onNewCommentBodyChange: (body: string) => void;
  editingCommentId: string | null;
  editingCommentBody: string;
  onEditingCommentBodyChange: (body: string) => void;
  onAddComment: () => void;
  onSaveComment: (commentId: string) => void;
  onDeleteComment: (commentId: string) => void;
  onStartEditComment: (comment: KanbanCardComment) => void;
  onCancelEditComment: () => void;
}) {
  return (
    <div className={className}>
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
                  {formatRelativeTime(comment.createdAt)}
                </span>
              </div>
              {editingCommentId === comment.id ? (
                <div className="space-y-2">
                  <Textarea
                    value={editingCommentBody}
                    onChange={(e) => onEditingCommentBodyChange(e.target.value)}
                    rows={3}
                    autoFocus
                  />
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      onClick={() => onSaveComment(comment.id)}
                      disabled={!editingCommentBody.trim()}
                    >
                      Save
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={onCancelEditComment}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="[overflow-wrap:anywhere]">
                    <Markdown>{comment.body}</Markdown>
                  </div>
                  <div className="flex gap-2">
                    <button
                      className="text-xs text-muted-foreground hover:text-foreground"
                      onClick={() => onStartEditComment(comment)}
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
                        <p className="text-sm mb-3">Delete this comment?</p>
                        <Button
                          variant="destructive"
                          size="sm"
                          className="w-full"
                          onClick={() => onDeleteComment(comment.id)}
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
          onChange={(e) => onNewCommentBodyChange(e.target.value)}
          placeholder="Add a comment..."
          rows={3}
        />
        <Button
          size="sm"
          onClick={onAddComment}
          disabled={!newCommentBody.trim()}
        >
          Comment
        </Button>
      </div>
    </div>
  );
}

// The card's metadata fields. Mobile stacks them under the details pane;
// desktop puts them in a sidebar. The container only differs by `className`.
function CardMetadataSection({
  className,
  createdAt,
  createdByName,
  updatedAt,
  lastEditedByName,
  columns,
  selectedColumnId,
  onColumnChange,
  labels,
  selectedLabelIds,
  onToggleLabel,
  selectedPriority,
  onPriorityChange,
  selectedDueDate,
  onDueDateChange,
  user,
  agents,
  selectedAssignees,
  onToggleAssignee,
}: {
  className?: string;
  createdAt: KanbanCard["createdAt"];
  createdByName: KanbanCard["createdByName"];
  updatedAt: KanbanCard["updatedAt"];
  lastEditedByName: KanbanCard["lastEditedByName"];
  columns: Pick<KanbanColumn, "id" | "name">[];
  selectedColumnId: string | null;
  onColumnChange: (columnId: string) => void;
  labels: KanbanLabel[];
  selectedLabelIds: string[];
  onToggleLabel: (labelId: string) => void;
  selectedPriority: KanbanCardPriority;
  onPriorityChange: (priority: KanbanCardPriority) => void;
  selectedDueDate: string | null;
  onDueDateChange: (dueDate: string | null) => void;
  user: { id: string; name: string; image?: string | null } | null;
  agents?: AgentOption[];
  selectedAssignees: KanbanCardAssignee[];
  onToggleAssignee: (type: "user" | "agent", id: string) => void;
}) {
  return (
    <div className={className}>
      {columns.length > 1 && selectedColumnId && (
        <div>
          <p className="text-xs font-medium text-muted-foreground mb-2">
            Column
          </p>
          <Select value={selectedColumnId} onValueChange={onColumnChange}>
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
                  onClick={() => onToggleLabel(label.id)}
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
          onValueChange={(v) => onPriorityChange(v as KanbanCardPriority)}
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
              selected={selectedDueDate ? new Date(selectedDueDate) : undefined}
              onSelect={(date) =>
                onDueDateChange(date ? date.toISOString() : null)
              }
            />
          </PopoverContent>
        </Popover>
      </div>

      {/* Assignees */}
      <AssigneePicker
        user={user}
        agents={agents}
        selectedAssignees={selectedAssignees}
        onToggle={onToggleAssignee}
      />

      <div>
        <p className="text-xs font-medium text-muted-foreground mb-2">
          Created
        </p>
        <p className="text-xs text-muted-foreground">
          {format(new Date(createdAt), "MMM d, yyyy 'at' h:mm a")}
          {createdByName && <> by {createdByName}</>}
        </p>
      </div>
      <div>
        <p className="text-xs font-medium text-muted-foreground mb-2">
          Updated
        </p>
        <p className="text-xs text-muted-foreground">
          {format(new Date(updatedAt), "MMM d, yyyy 'at' h:mm a")}
          {lastEditedByName && <> by {lastEditedByName}</>}
        </p>
      </div>
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
  onSave: (cardId: string, data: CardSaveData) => void;
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

  // No card yet means no comment thread to name, so nothing is read.
  const { data: commentsData, mutate: mutateComments } = useScopedSWR<{
    results: KanbanCardComment[];
  }>(
    `boards/${boardId}/cards/${card?.id ?? ""}/comments`,
    card ? { orgId, workspaceId } : null,
  );

  const comments = commentsData?.results ?? [];

  // Fetch workspace agents for assignee picker
  const { data: agentsData } = useScopedSWR<{
    results: AgentOption[];
  }>("agents", { orgId, workspaceId });

  const enterEditing = (field: "title" | "body") => {
    setFocusField(field);
    setIsEditing(true);
  };

  // Re-initialise the dialog whenever a different card is shown, the card is
  // updated server-side, or the target column changes.
  useResetOnChange(
    `${card?.id ?? ""}:${String(card?.updatedAt ?? "")}:${initialColumnId ?? ""}`,
    () => {
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
    },
  );

  if (!card) return null;

  const handleCopyToClipboard = async () => {
    const markdown = body ? `# ${title}\n\n${body}` : `# ${title}`;
    try {
      await navigator.clipboard.writeText(markdown);
      toast.success("Copied to clipboard");
    } catch {
      toast.error("Failed to copy to clipboard");
    }
  };

  const handleCopyLink = async () => {
    const url = new URL(window.location.href);
    url.searchParams.set("cardId", card.id);
    try {
      await navigator.clipboard.writeText(url.toString());
      toast.success("Link copied to clipboard");
    } catch {
      toast.error("Failed to copy link");
    }
  };

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

  const startEditingComment = (comment: KanbanCardComment) => {
    setEditingCommentId(comment.id);
    setEditingCommentBody(comment.body);
  };

  const cancelEditingComment = () => {
    setEditingCommentId(null);
    setEditingCommentBody("");
  };

  const commentsEntity = `boards/${boardId}/cards/${card.id}/comments`;

  const handleAddComment = async () => {
    if (!newCommentBody.trim() || !backendUrl) return;
    const outcome = await writeEntity(
      backendUrl,
      commentsEntity,
      { orgId, workspaceId },
      { data: { body: newCommentBody.trim() } },
    );
    if (outcome.outcome !== "success") {
      toast.error(outcome.message);
      return;
    }
    setNewCommentBody("");
    await mutateComments();
  };

  const handleEditComment = async (commentId: string) => {
    if (!editingCommentBody.trim() || !backendUrl) return;
    const outcome = await writeEntity(
      backendUrl,
      commentsEntity,
      { orgId, workspaceId },
      { id: commentId, data: { body: editingCommentBody.trim() } },
    );
    if (outcome.outcome !== "success") {
      toast.error(outcome.message);
      return;
    }
    cancelEditingComment();
    await mutateComments();
  };

  const handleDeleteComment = async (commentId: string) => {
    if (!backendUrl) return;
    const outcome = await writeEntity(
      backendUrl,
      commentsEntity,
      { orgId, workspaceId },
      { id: commentId },
    );
    if (outcome.outcome !== "success") {
      toast.error(outcome.message);
      return;
    }
    await mutateComments();
  };

  const handleDetailsBlur: FocusEventHandler<HTMLDivElement> = (event) => {
    if (!event.currentTarget.contains(event.relatedTarget)) {
      setIsEditing(false);
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
              <TabsTrigger value="history">History</TabsTrigger>
            </TabsList>
            <TabsContent
              value="details"
              className="flex-1 min-h-0 flex flex-col mt-0 pt-4 min-w-0"
            >
              <CardDetailsPane
                title={title}
                body={body}
                isEditing={isEditing}
                focusField={focusField}
                onTitleChange={setTitle}
                onBodyChange={setBody}
                onCopyLink={handleCopyLink}
                onCopyMarkdown={handleCopyToClipboard}
                onEdit={() => enterEditing("title")}
                onBlur={handleDetailsBlur}
              >
                <CardMetadataSection
                  className="border-t pt-4 space-y-4 min-w-0"
                  createdAt={card.createdAt}
                  createdByName={card.createdByName}
                  updatedAt={card.updatedAt}
                  lastEditedByName={card.lastEditedByName}
                  columns={columns}
                  selectedColumnId={selectedColumnId}
                  onColumnChange={setSelectedColumnId}
                  labels={labels}
                  selectedLabelIds={selectedLabelIds}
                  onToggleLabel={toggleLabel}
                  selectedPriority={selectedPriority}
                  onPriorityChange={setSelectedPriority}
                  selectedDueDate={selectedDueDate}
                  onDueDateChange={setSelectedDueDate}
                  user={user}
                  agents={agentsData?.results}
                  selectedAssignees={selectedAssignees}
                  onToggleAssignee={toggleAssignee}
                />
              </CardDetailsPane>
            </TabsContent>
            <TabsContent
              value="comments"
              className="flex-1 overflow-y-auto mt-0 pt-4 min-w-0"
            >
              <CommentsSection
                comments={comments}
                newCommentBody={newCommentBody}
                onNewCommentBodyChange={setNewCommentBody}
                editingCommentId={editingCommentId}
                editingCommentBody={editingCommentBody}
                onEditingCommentBodyChange={setEditingCommentBody}
                onAddComment={handleAddComment}
                onSaveComment={handleEditComment}
                onDeleteComment={handleDeleteComment}
                onStartEditComment={startEditingComment}
                onCancelEditComment={cancelEditingComment}
              />
            </TabsContent>
            <TabsContent
              value="history"
              className="flex-1 overflow-y-auto mt-0 pt-4 min-w-0"
            >
              <KanbanCardHistory
                orgId={orgId}
                workspaceId={workspaceId}
                boardId={boardId}
                cardId={card.id}
              />
            </TabsContent>
          </Tabs>
        ) : (
          <div className="flex flex-row gap-2 min-h-0 flex-1 overflow-hidden">
            {/* Main content - Title, Body, Comments, and History */}
            <CardDetailsPane
              className="min-w-0 pr-6"
              title={title}
              body={body}
              isEditing={isEditing}
              focusField={focusField}
              onTitleChange={setTitle}
              onBodyChange={setBody}
              onCopyLink={handleCopyLink}
              onCopyMarkdown={handleCopyToClipboard}
              onEdit={() => enterEditing("title")}
              onBlur={handleDetailsBlur}
            >
              <CommentsSection
                className="border-t pt-4"
                comments={comments}
                newCommentBody={newCommentBody}
                onNewCommentBodyChange={setNewCommentBody}
                editingCommentId={editingCommentId}
                editingCommentBody={editingCommentBody}
                onEditingCommentBodyChange={setEditingCommentBody}
                onAddComment={handleAddComment}
                onSaveComment={handleEditComment}
                onDeleteComment={handleDeleteComment}
                onStartEditComment={startEditingComment}
                onCancelEditComment={cancelEditingComment}
              />
              <div className="mt-6">
                <KanbanCardHistory
                  orgId={orgId}
                  workspaceId={workspaceId}
                  boardId={boardId}
                  cardId={card.id}
                />
              </div>
            </CardDetailsPane>

            {/* Sidebar - Column, Labels, Assignees, Due Date, Priority, and Metadata */}
            <CardMetadataSection
              className="w-52 shrink-0 space-y-4 overflow-y-auto"
              createdAt={card.createdAt}
              createdByName={card.createdByName}
              updatedAt={card.updatedAt}
              lastEditedByName={card.lastEditedByName}
              columns={columns}
              selectedColumnId={selectedColumnId}
              onColumnChange={setSelectedColumnId}
              labels={labels}
              selectedLabelIds={selectedLabelIds}
              onToggleLabel={toggleLabel}
              selectedPriority={selectedPriority}
              onPriorityChange={setSelectedPriority}
              selectedDueDate={selectedDueDate}
              onDueDateChange={setSelectedDueDate}
              user={user}
              agents={agentsData?.results}
              selectedAssignees={selectedAssignees}
              onToggleAssignee={toggleAssignee}
            />
          </div>
        )}
        <DialogFooter className="shrink-0 flex-row justify-end">
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
