"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import {
  Copy,
  EllipsisVertical,
  Pause,
  Pencil,
  Play,
  Trash2,
  Unlink,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * An item-specific ⋮ entry, such as Manage attachments: a link (`href`, so
 * middle-click and open-in-new-tab work) or a handler (`onSelect`).
 */
export type RowAction = {
  readonly label: string;
  readonly icon: ReactNode;
  readonly disabled?: boolean;
} & (
  | { readonly href: string; readonly onSelect?: never }
  | { readonly onSelect: () => void; readonly href?: never }
);

/**
 * A list card's ⋮ menu, in the `card-conventions` order: Edit, item-specific
 * actions, Clone, Enable/Disable, separator, then Delete. A Shared row reads
 * "Edit in org settings" and Detach instead. Each item is left out when its
 * prop is; with none, there is no ⋮ at all.
 */
export function RowActionsMenu({
  name,
  shared = false,
  edit,
  actions = [],
  clone,
  toggle,
  remove,
}: {
  /** The row's name, for the ⋮ button's accessible name. */
  name: string;
  /** A Shared resource attached to the Workspace. */
  shared?: boolean;
  edit?: { href: string };
  /** Item-specific entries, shown in order between Edit and Clone. */
  actions?: readonly RowAction[];
  clone?: { onSelect: () => void };
  toggle?: { enabled: boolean; onSelect: () => void; disabled?: boolean };
  remove?: { onSelect: () => void };
}) {
  if (!edit && !actions.length && !clone && !toggle && !remove) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          className="text-muted-foreground"
          variant="ghost"
          size="icon"
          aria-label={`Actions for ${name}`}
          onClick={(e) => e.preventDefault()}
        >
          <EllipsisVertical />
        </Button>
      </DropdownMenuTrigger>
      {/* The row may be a link, and React bubbles the portalled menu's clicks
          to it: stop them there, without cancelling a Cmd-click's new tab. */}
      <DropdownMenuContent onClick={(e) => e.stopPropagation()}>
        {edit && (
          <DropdownMenuItem asChild>
            <Link href={edit.href}>
              <Pencil /> {shared ? "Edit in org settings" : "Edit"}
            </Link>
          </DropdownMenuItem>
        )}
        {actions.map((action) =>
          action.href ? (
            <DropdownMenuItem
              key={action.label}
              disabled={action.disabled}
              asChild
            >
              <Link href={action.href}>
                {action.icon} {action.label}
              </Link>
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem
              key={action.label}
              disabled={action.disabled}
              onSelect={action.onSelect}
            >
              {action.icon} {action.label}
            </DropdownMenuItem>
          ),
        )}
        {clone && (
          <DropdownMenuItem onSelect={clone.onSelect}>
            <Copy /> Clone
          </DropdownMenuItem>
        )}
        {toggle && (
          <DropdownMenuItem
            onSelect={toggle.onSelect}
            disabled={toggle.disabled}
          >
            {toggle.enabled ? (
              <>
                <Pause /> Disable
              </>
            ) : (
              <>
                <Play /> Enable
              </>
            )}
          </DropdownMenuItem>
        )}
        {remove && (
          <>
            {(edit || actions.length > 0 || clone || toggle) && (
              <DropdownMenuSeparator />
            )}
            <DropdownMenuItem
              className={
                shared ? undefined : "text-destructive focus:text-destructive"
              }
              onSelect={remove.onSelect}
            >
              {shared ? (
                <>
                  <Unlink /> Detach
                </>
              ) : (
                <>
                  <Trash2 /> Delete
                </>
              )}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
