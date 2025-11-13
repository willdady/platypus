"use client";

import {
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenu,
} from "@/components/ui/sidebar";
import { Settings, Unplug, Wrench } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

interface SettingsMenuProps {
  orgId: string;
  workspaceId: string;
}

export function SettingsMenu({ orgId, workspaceId }: SettingsMenuProps) {
  const pathname = usePathname();
  const workspaceHref = `/${orgId}/workspace/${workspaceId}/settings`;
  const providersHref = `/${orgId}/workspace/${workspaceId}/settings/providers`;

  return (
    <SidebarContent>
      <SidebarGroup>
        <SidebarGroupContent>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton asChild isActive={pathname === workspaceHref}>
                <Link href={workspaceHref}>
                  <Settings /> Workspace
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                asChild
                isActive={pathname.startsWith(providersHref)}
              >
                <Link href={providersHref}>
                  <Unplug /> Providers
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton asChild>
                <Link href={providersHref}>
                  <Wrench /> MCP
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
    </SidebarContent>
  );
}
