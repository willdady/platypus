"use client";

import {
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenu,
} from "@/components/ui/sidebar";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { workspaceSettingsLinks } from "@/lib/settings-links";

interface WorkspaceSettingsMenuProps {
  orgId: string;
  workspaceId: string;
}

export function WorkspaceSettingsMenu({
  orgId,
  workspaceId,
}: WorkspaceSettingsMenuProps) {
  const pathname = usePathname();

  return (
    <SidebarContent>
      <SidebarGroup>
        <SidebarGroupContent>
          <SidebarMenu>
            {workspaceSettingsLinks(orgId, workspaceId).map(
              ({ href, icon: Icon, label, exact }) => (
                <SidebarMenuItem key={href}>
                  <SidebarMenuButton
                    asChild
                    isActive={
                      exact ? pathname === href : pathname.startsWith(href)
                    }
                  >
                    <Link href={href}>
                      <Icon /> {label}
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ),
            )}
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
    </SidebarContent>
  );
}
