"use client";

import type { MouseEvent } from "react";
import { cn } from "@/lib/utils";
import type { SlashCommandPickerProps } from "@/lib/slash-commands";

/**
 * The command list, anchored above the composer.
 *
 * Positioned rather than rendered in a popover because focus must stay in the
 * textarea: the textarea is the input, the list is its listbox, and the
 * keyboard is owned by `useSlashCommands`. A popover would take focus on open
 * and hand it back on close, which on mobile dismisses the on-screen keyboard
 * and reopens it a moment later (the same problem the model picker works around
 * in `composer.tsx`).
 *
 * An unmatched name is not an error: the message still sends as the plain text
 * it already is. The muted empty line is the only warning, and it is deliberate
 * — it makes a typo visible before Enter without styling the text itself.
 */
export const SlashCommandPicker = ({
  open,
  items,
  hasCommands,
  activeName,
  listboxId,
  optionId,
  onSelect,
}: SlashCommandPickerProps) => {
  if (!open) return null;

  // Clicking an option must not blur the textarea: the caret is restored after
  // the completion lands, and a blur in between closes a mobile keyboard for
  // the round trip.
  const keepFocus = (event: MouseEvent) => event.preventDefault();

  return (
    <div className="absolute bottom-full inset-x-0 z-50 mb-2">
      <div className="bg-popover text-popover-foreground overflow-hidden rounded-md border shadow-md">
        {items.length === 0 ? (
          // Announced rather than merely shown: with no list to arrow
          // through, this line is the only thing telling a screen-reader user
          // the name they have typed matches nothing.
          <p
            className="text-muted-foreground px-3 py-2.5 text-sm"
            role="status"
          >
            {hasCommands
              ? "No matching skill — this will send as ordinary text."
              : "This agent has no skills assigned."}
          </p>
        ) : (
          <ul
            aria-label="Skills"
            className="max-h-64 overflow-y-auto p-1"
            id={listboxId}
            role="listbox"
          >
            {items.map((item) => (
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
                <span className="text-muted-foreground ml-auto truncate text-xs">
                  {item.description}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
};
