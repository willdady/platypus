"use client";

import { memo } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { MessageCircle, Calendar, User } from "lucide-react";
import type {
  KanbanCard,
  KanbanLabel,
  KanbanResolvedAssignee,
} from "@platypus/schemas";
import { KANBAN_CARD_PRIORITIES } from "@platypus/schemas";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { AgentAvatar } from "@/components/agent-avatar";
import { cn } from "@/lib/utils";
import { readableTextColor } from "@/lib/color";

/**
 * How each due-date status reads: its colour, and the words that carry it for
 * anyone who can't tell the colours apart.
 */
const DUE_DATE_STATUS = {
  overdue: {
    prefix: "Overdue: due",
    className: "text-destructive",
  },
  "due-soon": {
    prefix: "Due soon:",
    className: "text-warning-foreground",
  },
  normal: { prefix: "Due", className: "text-muted-foreground" },
} as const;

function getDueDateStatus(dueDate: string): "overdue" | "due-soon" | "normal" {
  const now = new Date();
  const due = new Date(dueDate);
  if (due < now) return "overdue";
  const diff = due.getTime() - now.getTime();
  if (diff < 24 * 60 * 60 * 1000) return "due-soon";
  return "normal";
}

function formatDueDate(dueDate: string): string {
  const date = new Date(dueDate);
  const now = new Date();
  const isThisYear = date.getFullYear() === now.getFullYear();
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(isThisYear ? {} : { year: "numeric" }),
  });
}

const KanbanCardComponentInner = function KanbanCardComponent({
  card,
  labels,
  draggable = true,
  disabled = false,
  onCardClick,
}: {
  card: KanbanCard;
  labels: KanbanLabel[];
  draggable?: boolean;
  disabled?: boolean;
  onCardClick: (card: KanbanCard) => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: card.id,
    data: { type: "card", card },
    disabled,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  const cardLabels = labels.filter((l) => card.labelIds?.includes(l.id));
  const priorityConfig = KANBAN_CARD_PRIORITIES.find(
    (p) => p.value === card.priority,
  );
  const priorityColor = priorityConfig?.color ?? null;
  const priorityLabel = priorityColor ? priorityConfig?.label : null;

  const resolvedAssignees = (card.resolvedAssignees ??
    []) as KanbanResolvedAssignee[];
  const visibleAssignees = resolvedAssignees.slice(0, 3);
  const overflowCount = resolvedAssignees.length - 3;

  const dueDateStr = card.dueDate as string | null | undefined;
  const dueDateStatus = dueDateStr ? getDueDateStatus(dueDateStr) : null;

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      // dnd-kit's attributes carry the same role; spelled out for the linter,
      // which cannot see through the spread.
      role="button"
      {...(draggable ? listeners : {})}
      className={cn(
        "border rounded-lg bg-card p-3 shadow-sm",
        draggable ? "cursor-grab" : "cursor-pointer",
        priorityColor && "border-l-2",
      )}
      style={
        priorityColor ? { ...style, borderLeftColor: priorityColor } : style
      }
      onClick={() => onCardClick(card)}
      // Enter opens the card, as a click does. Space is left to dnd-kit's
      // keyboard sensor, which picks the card up to move it.
      onKeyDown={(event) => {
        if (draggable) listeners?.onKeyDown?.(event);
        // Mid-drag, Enter drops the card; it must not open it as well.
        if (event.key === "Enter" && !event.repeat && !isDragging) {
          event.preventDefault();
          onCardClick(card);
        }
      }}
    >
      <p className="text-sm font-medium">{card.title}</p>
      {priorityLabel && (
        <span className="sr-only">Priority: {priorityLabel}</span>
      )}
      {cardLabels.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-2">
          {cardLabels.map((label) => (
            <Badge
              key={label.id}
              className="border-0"
              style={{
                backgroundColor: label.color,
                color: readableTextColor(label.color),
              }}
            >
              {label.name}
            </Badge>
          ))}
        </div>
      )}
      {(dueDateStr ||
        card.commentCount > 0 ||
        resolvedAssignees.length > 0) && (
        <div className="flex items-center gap-2 mt-2 flex-wrap">
          {dueDateStr && (
            <div
              className={cn(
                "flex items-center gap-1 text-xs",
                dueDateStatus && DUE_DATE_STATUS[dueDateStatus].className,
              )}
            >
              <Calendar className="size-3" aria-hidden="true" />
              <span>
                {dueDateStatus && (
                  <span className="sr-only">
                    {DUE_DATE_STATUS[dueDateStatus].prefix}{" "}
                  </span>
                )}
                {formatDueDate(dueDateStr)}
              </span>
            </div>
          )}
          {card.commentCount > 0 && (
            <div className="flex items-center gap-1 text-muted-foreground">
              <MessageCircle className="size-3.5" />
              <span className="text-xs">{card.commentCount}</span>
            </div>
          )}
          {resolvedAssignees.length > 0 && (
            <div className="flex items-center -space-x-1 ml-auto">
              {visibleAssignees.map((assignee) =>
                assignee.type === "agent" ? (
                  <AgentAvatar
                    key={`${assignee.type}-${assignee.id}`}
                    agent={{
                      name: assignee.name,
                      avatarUrl: assignee.image ?? undefined,
                    }}
                    className="size-5 border border-background"
                  />
                ) : (
                  <Avatar
                    key={`${assignee.type}-${assignee.id}`}
                    className="size-5 border border-background"
                  >
                    {assignee.image && (
                      <AvatarImage src={assignee.image} alt={assignee.name} />
                    )}
                    <AvatarFallback>
                      <User className="size-3 text-muted-foreground" />
                    </AvatarFallback>
                  </Avatar>
                ),
              )}
              {overflowCount > 0 && (
                <div className="size-5 rounded-full bg-muted border border-background flex items-center justify-center">
                  <span className="text-[8px] text-muted-foreground">
                    +{overflowCount}
                  </span>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export const KanbanCardComponent = memo(KanbanCardComponentInner);
