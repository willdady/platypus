"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import {
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

/** An item-specific ⋮ entry, such as Manage attachments. */
export interface RowAction {
  readonly label: string;
  readonly icon: ReactNode;
  readonly onSelect: () => void;
}

/**
 * A settings-list card's ⋮ menu, in the `card-conventions` order: Edit,
 * item-specific actions, Enable/Disable, separator, then Delete — or Detach,
 * for a Shared row. Each item is left out when its prop is; with none, there
 * is no ⋮ at all.
 */
export const RowActionsMenu = ({
  name,
  edit,
  actions = [],
  toggle,
  remove,
}: {
  /** The row's name, for the ⋮ button's accessible name. */
  name: string;
  edit?: { href: string; label?: string };
  /** Item-specific entries, shown in order between Edit and Enable/Disable. */
  actions?: readonly RowAction[];
  toggle?: { enabled: boolean; onSelect: () => void; disabled?: boolean };
  remove?: { kind: "delete" | "detach"; onSelect: () => void };
}) => {
  if (!edit && !actions.length && !toggle && !remove) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          className="cursor-pointer text-muted-foreground"
          variant="ghost"
          size="icon"
          aria-label={`Actions for ${name}`}
          onClick={(e) => e.preventDefault()}
        >
          <EllipsisVertical className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      {/* The card is a link: keep a menu click from following it. */}
      <DropdownMenuContent onClick={(e) => e.preventDefault()}>
        {edit && (
          <DropdownMenuItem asChild>
            <Link className="cursor-pointer" href={edit.href}>
              <Pencil /> {edit.label ?? "Edit"}
            </Link>
          </DropdownMenuItem>
        )}
        {actions.map((action) => (
          <DropdownMenuItem
            key={action.label}
            className="cursor-pointer"
            onSelect={action.onSelect}
          >
            {action.icon} {action.label}
          </DropdownMenuItem>
        ))}
        {toggle && (
          <DropdownMenuItem
            className="cursor-pointer"
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
            {(edit || actions.length > 0 || toggle) && (
              <DropdownMenuSeparator />
            )}
            <DropdownMenuItem
              className={
                remove.kind === "delete"
                  ? "cursor-pointer text-destructive focus:text-destructive"
                  : "cursor-pointer"
              }
              onSelect={remove.onSelect}
            >
              {remove.kind === "delete" ? (
                <>
                  <Trash2 /> Delete
                </>
              ) : (
                <>
                  <Unlink /> Detach
                </>
              )}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
