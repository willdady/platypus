"use client";

import { memo } from "react";
import { useSortable } from "@dnd-kit/sortable";
import {
  SortableContext,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { useDroppable } from "@dnd-kit/core";
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
import { cn } from "@/lib/utils";

const KanbanColumnComponentInner = function KanbanColumnComponent({
  column,
  labels,
  draggable = true,
  isFirst = false,
  isLast = false,
  onCardClick,
  onAddCard,
  onEditColumn,
  onDeleteColumn,
  onMoveColumn,
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
}) {
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

  const { setNodeRef: setDroppableRef, isOver } = useDroppable({
    id: column.id,
    data: { type: "column", column },
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  const cardIds = column.cards.map((c) => c.id);
  const hasCards = column.cards.length > 0;

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="flex flex-col w-80 min-w-80 shrink-0 bg-muted/50 rounded-lg"
    >
      <div
        className={cn(
          "flex items-center justify-between p-3",
          draggable && "cursor-grab",
        )}
        {...attributes}
        {...(draggable ? listeners : {})}
      >
        <span className="font-semibold">{column.name}</span>
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
        ref={setDroppableRef}
        className={cn(
          "flex-1 overflow-y-auto p-2 space-y-2 min-h-[100px] transition-colors",
          isOver && "bg-primary/10 rounded-md",
        )}
      >
        <SortableContext items={cardIds} strategy={verticalListSortingStrategy}>
          {column.cards.map((card) => (
            <KanbanCardComponent
              key={card.id}
              card={card}
              labels={labels}
              draggable={draggable}
              onClick={() => onCardClick(card)}
            />
          ))}
        </SortableContext>
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
    </div>
  );
};

export const KanbanColumnComponent = memo(KanbanColumnComponentInner);
