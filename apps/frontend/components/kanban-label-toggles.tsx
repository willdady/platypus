"use client";

import type { KanbanLabel } from "@platypus/schemas";
import { readableTextColor } from "@/lib/color";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export function KanbanLabelToggles({
  labels,
  selectedIds,
  onChange,
  labelledBy,
  className,
}: {
  labels: KanbanLabel[];
  selectedIds: string[];
  onChange: (selectedIds: string[]) => void;
  labelledBy: string;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-labelledby={labelledBy}
      className={cn("flex flex-wrap gap-1.5", className)}
    >
      {labels.map((label) => {
        const isSelected = selectedIds.includes(label.id);
        return (
          <Badge
            key={label.id}
            asChild
            className="cursor-pointer border-0 transition-opacity"
            style={{
              backgroundColor: label.color,
              color: readableTextColor(label.color),
            }}
          >
            <button
              type="button"
              aria-pressed={isSelected}
              onClick={() =>
                onChange(
                  isSelected
                    ? selectedIds.filter((id) => id !== label.id)
                    : [...selectedIds, label.id],
                )
              }
              className={cn(
                "focus-visible:opacity-100",
                !isSelected && "opacity-40",
              )}
            >
              {label.name}
            </button>
          </Badge>
        );
      })}
    </div>
  );
}
