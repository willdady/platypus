"use client";

import type { MouseEvent } from "react";
import { cn } from "@/lib/utils";
import type { SlashCommandPickerProps } from "@/lib/slash-commands";

export function SlashCommandPicker({
  open,
  items,
  hasCommands,
  activeName,
  listboxId,
  optionId,
  onSelect,
}: SlashCommandPickerProps) {
  if (!open) return null;

  // why: no popover — focus stays in the textarea, or a mobile keyboard closes
  const keepFocus = (event: MouseEvent) => event.preventDefault();

  return (
    <div className="absolute bottom-full inset-x-0 z-50 mb-2">
      <div className="bg-popover text-popover-foreground overflow-hidden rounded-md border shadow-md">
        {items.length === 0 ? (
          <p
            className="text-muted-foreground px-3 py-2.5 text-sm"
            role="status"
          >
            {hasCommands
              ? "No matching command — this will send as ordinary text."
              : "This agent has no skills assigned."}
          </p>
        ) : (
          <ul
            aria-label="Commands"
            className="max-h-64 overflow-y-auto p-1"
            id={listboxId}
            role="listbox"
          >
            {items.map((item) => (
              // why: options never take focus; the composer owns the keyboard
              // eslint-disable-next-line jsx-a11y/click-events-have-key-events
              <li
                aria-selected={item.name === activeName}
                className={cn(
                  "flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm",
                  item.name === activeName &&
                    "bg-accent text-accent-foreground",
                )}
                id={optionId(item.name)}
                key={item.name}
                onClick={() => onSelect(item.name)}
                onMouseDown={keepFocus}
                role="option"
              >
                <span className="font-medium">/{item.name}</span>
                {item.argumentHint && (
                  <span className="text-muted-foreground shrink-0 text-xs">
                    {item.argumentHint}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
