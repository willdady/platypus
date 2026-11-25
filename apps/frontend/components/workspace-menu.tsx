"use client";

import { useState, type CSSProperties } from "react";
import { PanelLeftIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SIDEBAR_WIDTH_MOBILE } from "@/components/ui/sidebar";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { WorkspaceSheetNavigation } from "@/components/workspace-sheet-navigation";

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
          <PanelLeftIcon />
        </Button>
      </SheetTrigger>
      <SheetContent
        side="left"
        className="bg-sidebar text-sidebar-foreground w-(--sidebar-width) p-0 [&>button]:hidden"
        style={{ "--sidebar-width": SIDEBAR_WIDTH_MOBILE } as CSSProperties}
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
