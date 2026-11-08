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
 * An entry that is either a link (`href`, so middle-click and open-in-new-tab
 * work) or a handler (`onSelect`).
 */
type LinkOrHandler =
  | { readonly href: string; readonly onSelect?: never }
  | { readonly onSelect: () => void; readonly href?: never };

/**
 * An item-specific ⋮ entry, such as Manage attachments.
 */
export type RowAction = {
  readonly label: string;
  readonly icon: ReactNode;
  readonly disabled?: boolean;
} & LinkOrHandler;

/** One menu item, rendered as a link or a handler. */
function RowMenuItem({
  target,
  disabled,
  children,
}: {
  target: LinkOrHandler;
  disabled?: boolean;
  children: ReactNode;
}) {
  if (target.href) {
    return (
      <DropdownMenuItem disabled={disabled} asChild>
        <Link href={target.href}>{children}</Link>
      </DropdownMenuItem>
    );
  }

  return (
    <DropdownMenuItem disabled={disabled} onSelect={target.onSelect}>
      {children}
    </DropdownMenuItem>
  );
}

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
  stopTriggerClick = false,
}: {
  /** The row's name, for the ⋮ button's accessible name. */
  name: string;
  /** A Shared resource attached to the Workspace. */
  shared?: boolean;
  /** A link, or a handler for an edit dialog. */
  edit?: LinkOrHandler;
  /** Item-specific entries, shown in order between Edit and Clone. */
  actions?: readonly RowAction[];
  clone?: { onSelect: () => void };
  toggle?: { enabled: boolean; onSelect: () => void; disabled?: boolean };
  /**
   * Delete, or Detach on a Shared row. `label` renames Delete; Detach keeps
   * its own label on a Shared row.
   */
  remove?: { onSelect: () => void; label?: string };
  /** Keep the trigger's click from reaching a clickable ancestor. */
  stopTriggerClick?: boolean;
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
          onClick={(e) => {
            e.preventDefault();
            if (stopTriggerClick) e.stopPropagation();
          }}
        >
          <EllipsisVertical />
        </Button>
      </DropdownMenuTrigger>
      {/* The row may be a link, and React bubbles the portalled menu's clicks
          to it: stop them there, without cancelling a Cmd-click's new tab. */}
      <DropdownMenuContent onClick={(e) => e.stopPropagation()}>
        {edit && (
          <RowMenuItem target={edit}>
            <Pencil /> {shared && edit.href ? "Edit in org settings" : "Edit"}
          </RowMenuItem>
        )}
        {actions.map((action) => (
          <RowMenuItem
            key={action.label}
            target={action}
            disabled={action.disabled}
          >
            {action.icon} {action.label}
          </RowMenuItem>
        ))}
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
              variant={shared ? "default" : "destructive"}
              onSelect={remove.onSelect}
            >
              {shared ? (
                <>
                  <Unlink /> Detach
                </>
              ) : (
                <>
                  <Trash2 /> {remove.label ?? "Delete"}
                </>
              )}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
