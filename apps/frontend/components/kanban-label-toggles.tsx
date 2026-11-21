"use client";

import type { KanbanLabel } from "@platypus/schemas";
import { readableTextColor } from "@/lib/color";
import { cn } from "@/lib/utils";
import { badgeVariants } from "@/components/ui/badge";

/**
 * Label chips that behave as toggle buttons: focusable, toggled with Space or
 * Enter, and exposing their state through `aria-pressed`.
 */
export function KanbanLabelToggles({
  labels,
  selectedIds,
  onToggle,
  labelledBy,
  className,
}: {
  labels: KanbanLabel[];
  selectedIds: string[];
  onToggle: (labelId: string) => void;
  /** Id of the element that names the group, normally its heading. */
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
        const isActive = selectedIds.includes(label.id);
        return (
          <button
            key={label.id}
            type="button"
            aria-pressed={isActive}
            onClick={() => onToggle(label.id)}
            className={cn(
              badgeVariants(),
              "cursor-pointer transition-opacity border-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              !isActive && "opacity-40",
            )}
            style={{
              backgroundColor: label.color,
              color: readableTextColor(label.color),
            }}
          >
            {label.name}
          </button>
        );
      })}
    </div>
  );
}
