"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import {
  workspaceNavItems,
  workspaceSection,
} from "@/components/workspace-nav";
import { WorkspaceSwitcher } from "@/components/workspace-switcher";
import { workspaceRoutes } from "@/lib/routes";

export function WorkspaceSheetNavigation({
  orgId,
  workspaceId,
  onNavigate,
}: {
  orgId: string;
  workspaceId: string;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const routes = workspaceRoutes(orgId, workspaceId);
  const current = workspaceSection(pathname, routes);

  return (
    <>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <WorkspaceSwitcher
              orgId={orgId}
              workspaceId={workspaceId}
              presentation="sheet"
              onNavigate={onNavigate}
            />
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <nav aria-label="Workspace" className="px-2">
        <SidebarMenu>
          {workspaceNavItems(orgId, workspaceId)
            // why: the header's Home is one tap, so the sheet lists only what it cannot reach
            .filter(({ section }) => section !== "home")
            .map(({ section, label, href, icon: Icon }) => (
              <SidebarMenuItem key={section}>
                <SidebarMenuButton
                  asChild
                  isActive={current === section}
                  aria-current={current === section ? "page" : undefined}
                >
                  <Link href={href} onClick={onNavigate}>
                    <Icon /> <span>{label}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
        </SidebarMenu>
      </nav>
    </>
  );
}
