"use client";

import { memo } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { KanbanCard, KanbanLabel } from "@platypus/schemas";
import { KanbanLabelBadge } from "@/components/kanban-label-badge";

const KanbanCardComponentInner = function KanbanCardComponent({
  card,
  labels,
  onClick,
}: {
  card: KanbanCard;
  labels: KanbanLabel[];
  onClick: () => void;
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
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  const cardLabels = labels.filter((l) => card.labelIds?.includes(l.id));

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className="border rounded-lg bg-card p-3 shadow-sm cursor-grab"
      onClick={onClick}
    >
      <p className="text-sm font-medium">{card.title}</p>
      {cardLabels.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-2">
          {cardLabels.map((label) => (
            <KanbanLabelBadge
              key={label.id}
              name={label.name}
              color={label.color}
            />
          ))}
        </div>
      )}
    </div>
  );
};

export const KanbanCardComponent = memo(KanbanCardComponentInner);
