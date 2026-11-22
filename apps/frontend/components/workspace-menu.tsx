"use client";

import { useState, type CSSProperties } from "react";
import { Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { WorkspaceSheetNavigation } from "@/components/workspace-sheet-navigation";

/**
 * The phone's menu button and sheet on a Workspace screen without the app
 * sidebar. Below the breakpoint the rail is not drawn, so the sheet holds the
 * Workspace's destinations instead; picking one closes it.
 */
export function WorkspaceMenu({
  orgId,
  workspaceId,
}: {
  orgId: string;
  workspaceId: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Open menu"
          className="md:hidden"
        >
          <Menu />
        </Button>
      </SheetTrigger>
      <SheetContent
        side="left"
        className="bg-sidebar text-sidebar-foreground w-(--sidebar-width) p-0 [&>button]:hidden"
        style={{ "--sidebar-width": "18rem" } as CSSProperties}
      >
        <SheetHeader className="sr-only">
          <SheetTitle>Navigation</SheetTitle>
          <SheetDescription>Workspace navigation.</SheetDescription>
        </SheetHeader>
        <div className="flex size-full flex-col">
          <WorkspaceSheetNavigation
            orgId={orgId}
            workspaceId={workspaceId}
            onNavigate={() => setOpen(false)}
          />
        </div>
      </SheetContent>
    </Sheet>
  );
}
