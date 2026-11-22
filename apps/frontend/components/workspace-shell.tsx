import { type ReactNode } from "react";
import { Search } from "lucide-react";
import { AppSidebar } from "@/components/app-sidebar";
import { BackButton } from "@/components/back-button";
import { CommandMenu } from "@/components/command-menu";
import { Header } from "@/components/header";
import { HeaderHomeButton } from "@/components/header-home-button";
import { MAIN_CONTENT_ID } from "@/components/skip-link";
import { WorkspaceBackButton } from "@/components/workspace-back-button";
import { WorkspaceMenu } from "@/components/workspace-menu";
import { WorkspaceRail } from "@/components/workspace-rail";
import { WorkspaceScrollContainer } from "@/components/workspace-scroll-container";
import { WorkspaceSwitcher } from "@/components/workspace-switcher";
import { Kbd } from "@/components/ui/kbd";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { orgRoutes, workspaceRoutes } from "@/lib/routes";
import { cn } from "@/lib/utils";

type WorkspaceShellProps = {
  orgId: string;
  /**
   * The Workspace the header acts on. Omitted where it couldn't be read (the
   * not-found boundary, and the error boundary above the Workspace layout):
   * the header then leads to the Organization home, where the Workspace list
   * lives.
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
      {workspaceId && <WorkspaceRail orgId={orgId} workspaceId={workspaceId} />}
      {sidebar && <AppSidebar />}
      <SidebarInset
        id={MAIN_CONTENT_ID}
        // The rail is fixed to the window's left edge; the inset leaves the
        // same column clear so the content — and the sidebar above it —
        // starts to its right.
        className={cn(
          "min-w-0",
          workspaceId && "md:pl-(--workspace-rail-width)",
        )}
      >
        <Header
          leftContent={
            <div className="flex min-w-0 items-center gap-2">
              {sidebar ? (
                <SidebarTrigger />
              ) : workspaceId ? (
                <>
                  <WorkspaceMenu orgId={orgId} workspaceId={workspaceId} />
                  <WorkspaceBackButton
                    orgId={orgId}
                    workspaceId={workspaceId}
                  />
                </>
              ) : (
                <BackButton variant="header" fallbackHref={home.href} />
              )}
              {workspaceId ? (
                <div className="hidden md:block">
                  <WorkspaceSwitcher
                    orgId={orgId}
                    workspaceId={workspaceId}
                    presentation="bar"
                  />
                </div>
              ) : (
                <HeaderHomeButton href={home.href} label={home.label} />
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
        {children}
      </SidebarInset>
    </SidebarProvider>
  );
}

/**
 * A Workspace route group's layout: the shell, the scrolling content and the
 * Command menu. The groups differ only in whether they draw the sidebar.
 */
export function workspaceGroupLayout({ sidebar }: { sidebar: boolean }) {
  return async function WorkspaceGroupLayout({
    children,
    params,
  }: Readonly<{
    children: ReactNode;
    params: Promise<{ orgId: string; workspaceId: string }>;
  }>) {
    const { orgId, workspaceId } = await params;

    return (
      <WorkspaceShell orgId={orgId} workspaceId={workspaceId} sidebar={sidebar}>
        <WorkspaceScrollContainer>{children}</WorkspaceScrollContainer>
        <CommandMenu orgId={orgId} workspaceId={workspaceId} />
      </WorkspaceShell>
    );
  };
}
