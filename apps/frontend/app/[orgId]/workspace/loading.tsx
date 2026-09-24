"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { Home, Search } from "lucide-react";
import { Header } from "@/components/header";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { SidebarInset, SidebarTrigger } from "@/components/ui/sidebar";
import { workspaceRoutes } from "@/lib/routes";

// The Workspace layout awaits the workspace on the server, and a segment's
// own `loading` can't cover its layout — so the fallback lives here, one
// segment up, inside the shell's sidebar. It mirrors the layout's header so
// only the content area changes when the Workspace lands, and leaves that area
// empty: it stands in for every Workspace page, so any placeholder drawn there
// would be the wrong shape, then swapped for the page's own skeleton. It shows
// when entering or switching Workspaces; navigation within one keeps the page up.
export default function WorkspaceLoading() {
  const { orgId, workspaceId } = useParams<{
    orgId: string;
    workspaceId?: string;
  }>();

  return (
    <SidebarInset className="min-w-0">
      <Header
        bordered={false}
        leftContent={
          <div className="flex items-center gap-2">
            <SidebarTrigger className="cursor-pointer" />
            {workspaceId && (
              <Button
                variant="ghost"
                size="icon"
                asChild
                className="size-7 cursor-pointer"
              >
                <Link href={workspaceRoutes(orgId, workspaceId).root}>
                  <Home />
                </Link>
              </Button>
            )}
          </div>
        }
        rightContent={
          <Kbd className="hidden text-sm font-sans md:flex">
            <Search className="size-4" /> ⌘K
          </Kbd>
        }
        scope={workspaceId ? { orgId, workspaceId } : { orgId }}
      />
      <div
        role="status"
        aria-busy="true"
        aria-label="Loading workspace"
        className="flex-1"
      />
    </SidebarInset>
  );
}
