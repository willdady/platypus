"use client";

import { memo } from "react";
import { useSortable } from "@dnd-kit/sortable";
import {
  SortableContext,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { useDndContext, useDroppable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import type { KanbanCard, KanbanColumn, KanbanLabel } from "@platypus/schemas";
import { KanbanCardComponent } from "@/components/kanban-card";
import {
  Plus,
  MoreVertical,
  Pencil,
  Trash2,
  ArrowLeft,
  ArrowRight,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

type KanbanColumnProps = {
  column: KanbanColumn & { cards: KanbanCard[] };
  labels: KanbanLabel[];
  draggable?: boolean;
  isDraggingColumn?: boolean;
  overlay?: boolean;
  isFirst?: boolean;
  isLast?: boolean;
  onCardClick: (card: KanbanCard) => void;
  onAddCard: (columnId: string) => void;
  onEditColumn: (columnId: string) => void;
  onDeleteColumn: (columnId: string, hasCards: boolean) => void;
  onMoveColumn?: (columnId: string, direction: "left" | "right") => void;
};

function ColumnContent({
  column,
  labels,
  draggable,
  isFirst,
  isLast,
  onCardClick,
  onAddCard,
  onEditColumn,
  onDeleteColumn,
  onMoveColumn,
  dragHandleProps,
  cardDropRef,
  isOver,
  overlay,
  isDraggingColumn,
}: {
  column: KanbanColumn & { cards: KanbanCard[] };
  labels: KanbanLabel[];
  draggable?: boolean;
  isFirst?: boolean;
  isLast?: boolean;
  onCardClick: (card: KanbanCard) => void;
  onAddCard: (columnId: string) => void;
  onEditColumn: (columnId: string) => void;
  onDeleteColumn: (columnId: string, hasCards: boolean) => void;
  onMoveColumn?: (columnId: string, direction: "left" | "right") => void;
  dragHandleProps?: Record<string, unknown>;
  cardDropRef?: (node: HTMLElement | null) => void;
  isOver?: boolean;
  overlay?: boolean;
  isDraggingColumn?: boolean;
}) {
  const hasCards = column.cards.length > 0;
  const cardIds = column.cards.map((c) => c.id);

  return (
    <>
      <div
        className={cn(
          "flex items-center justify-between p-3",
          draggable && "cursor-grab",
        )}
        {...(dragHandleProps ?? {})}
      >
        <div className="flex items-center gap-2">
          <span className="font-semibold">{column.name}</span>
          <Badge variant="outline">{column.cards.length}</Badge>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              className="p-1 hover:bg-muted rounded"
              onClick={(e) => e.stopPropagation()}
            >
              <MoreVertical className="h-4 w-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem
              disabled={isFirst}
              onSelect={() => onMoveColumn?.(column.id, "left")}
            >
              <ArrowLeft className="h-4 w-4" />
              Move column left
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={isLast}
              onSelect={() => onMoveColumn?.(column.id, "right")}
            >
              <ArrowRight className="h-4 w-4" />
              Move column right
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => onEditColumn(column.id)}>
              <Pencil className="h-4 w-4" />
              Edit
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => onDeleteColumn(column.id, hasCards)}
            >
              <Trash2 className="h-4 w-4" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div
        ref={cardDropRef}
        className={cn(
          "flex-1 overflow-y-auto p-2 space-y-2 min-h-[100px] transition-colors",
          isOver && "bg-primary/10 rounded-md",
        )}
      >
        {overlay ? (
          column.cards.map((card) => (
            <KanbanCardComponent
              key={card.id}
              card={card}
              labels={labels}
              draggable={false}
              onClick={() => onCardClick(card)}
            />
          ))
        ) : (
          <SortableContext
            items={cardIds}
            strategy={verticalListSortingStrategy}
          >
            {column.cards.map((card) => (
              <KanbanCardComponent
                key={card.id}
                card={card}
                labels={labels}
                draggable={draggable}
                disabled={isDraggingColumn}
                onClick={() => onCardClick(card)}
              />
            ))}
          </SortableContext>
        )}
      </div>
      <div className="p-2">
        <Button
          variant="ghost"
          className="w-full justify-start text-muted-foreground"
          onClick={() => onAddCard(column.id)}
        >
          <Plus className="h-4 w-4 mr-2" /> Add card
        </Button>
      </div>
    </>
  );
}

const KanbanColumnComponentInner = function KanbanColumnComponent({
  column,
  labels,
  draggable = true,
  isDraggingColumn = false,
  overlay = false,
  isFirst = false,
  isLast = false,
  onCardClick,
  onAddCard,
  onEditColumn,
  onDeleteColumn,
  onMoveColumn,
}: KanbanColumnProps) {
  // Overlay instances render as plain static elements — no dnd hooks
  if (overlay) {
    return (
      <div className="flex flex-col w-80 min-w-80 shrink-0 bg-muted/50 rounded-lg">
        <ColumnContent
          column={column}
          labels={labels}
          draggable={false}
          isFirst={isFirst}
          isLast={isLast}
          onCardClick={onCardClick}
          onAddCard={onAddCard}
          onEditColumn={onEditColumn}
          onDeleteColumn={onDeleteColumn}
          onMoveColumn={onMoveColumn}
          overlay
        />
      </div>
    );
  }

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: column.id,
    data: { type: "column", column },
  });

  const { setNodeRef: setDroppableRef } = useDroppable({
    id: `column-drop-${column.id}`,
    data: { type: "column", column },
    disabled: isDraggingColumn,
  });

  // Broaden the highlight: useDroppable's isOver only fires when the
  // over-target is the column drop-zone itself.  When the cursor is over a
  // card, that card is the over-target, so the column wouldn't highlight.
  // Read the active over from context instead and treat the column as
  // "over" if the over-target is the drop-zone, the column's sortable, or
  // any card that belongs to this column.
  const { active, over } = useDndContext();
  const overId = over ? String(over.id) : null;
  const isOver =
    !!active &&
    overId !== null &&
    (overId === `column-drop-${column.id}` ||
      overId === column.id ||
      column.cards.some((c) => c.id === overId));

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="flex flex-col w-80 min-w-80 shrink-0 bg-muted/50 rounded-lg"
    >
      <ColumnContent
        column={column}
        labels={labels}
        draggable={draggable}
        isFirst={isFirst}
        isLast={isLast}
        onCardClick={onCardClick}
        onAddCard={onAddCard}
        onEditColumn={onEditColumn}
        onDeleteColumn={onDeleteColumn}
        onMoveColumn={onMoveColumn}
        dragHandleProps={{ ...attributes, ...(draggable ? listeners : {}) }}
        cardDropRef={setDroppableRef}
        isOver={isOver}
        isDraggingColumn={isDraggingColumn}
      />
    </div>
  );
};

export const KanbanColumnComponent = memo(KanbanColumnComponentInner);
