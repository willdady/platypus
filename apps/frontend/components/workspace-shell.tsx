import { type ReactNode } from "react";
import Link from "next/link";
import { Home, Search } from "lucide-react";
import { AppSidebar } from "@/components/app-sidebar";
import { BackButton } from "@/components/back-button";
import { Header } from "@/components/header";
import { MAIN_CONTENT_ID } from "@/components/skip-link";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { orgRoutes, workspaceRoutes } from "@/lib/routes";

type WorkspaceShellProps = {
  orgId: string;
  /**
   * The Workspace the header acts on. Omitted where it couldn't be read (the
   * not-found and error boundaries): the header then leads to the
   * Organization home, where the Workspace list lives.
   */
  workspaceId?: string;
  /**
   * Draw the app sidebar — the Workspace home and Chat only. Without it the
   * content takes the full width and the header holds a Back.
   */
  sidebar?: boolean;
  children: ReactNode;
};

/** The chrome around every Workspace screen and its boundaries. */
export function WorkspaceShell({
  orgId,
  workspaceId,
  sidebar = false,
  children,
}: WorkspaceShellProps) {
  const home = workspaceId
    ? {
        href: workspaceRoutes(orgId, workspaceId).root,
        label: "Workspace home",
      }
    : { href: orgRoutes(orgId).root, label: "Organization home" };

  return (
    <SidebarProvider className="min-h-0 h-dvh">
      {sidebar && <AppSidebar />}
      <SidebarInset id={MAIN_CONTENT_ID} className="min-w-0">
        <Header
          bordered={!sidebar}
          leftContent={
            <div className="flex items-center gap-2">
              {sidebar ? (
                <SidebarTrigger />
              ) : (
                <BackButton variant="header" fallbackHref={home.href} />
              )}
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={home.label}
                asChild
              >
                <Link href={home.href}>
                  <Home />
                </Link>
              </Button>
            </div>
          }
          rightContent={
            <Kbd className="hidden text-sm font-sans md:flex">
              <Search className="size-4" /> ⌘K
            </Kbd>
          }
          scope={workspaceId ? { orgId, workspaceId } : { orgId }}
        />
        {children}
      </SidebarInset>
    </SidebarProvider>
  );
}
