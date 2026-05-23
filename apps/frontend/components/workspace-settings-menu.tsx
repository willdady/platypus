"use client";

import {
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenu,
} from "@/components/ui/sidebar";
import { Box, Info, Radio, Settings, Unplug, Wrench } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

interface WorkspaceSettingsMenuProps {
  orgId: string;
  workspaceId: string;
}

export function WorkspaceSettingsMenu({
  orgId,
  workspaceId,
}: WorkspaceSettingsMenuProps) {
  const pathname = usePathname();
  const workspaceHref = `/${orgId}/workspace/${workspaceId}/settings`;
  const providersHref = `/${orgId}/workspace/${workspaceId}/settings/providers`;
  const mcpHref = `/${orgId}/workspace/${workspaceId}/settings/mcp`;
  const sandboxHref = `/${orgId}/workspace/${workspaceId}/settings/sandbox`;
  const webhookHref = `/${orgId}/workspace/${workspaceId}/settings/webhooks`;
  const aboutHref = `/${orgId}/workspace/${workspaceId}/settings/about`;

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
              <SidebarMenuButton
                asChild
                isActive={pathname.startsWith(mcpHref)}
              >
                <Link href={mcpHref}>
                  <Wrench /> MCP
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                asChild
                isActive={pathname.startsWith(sandboxHref)}
              >
                <Link href={sandboxHref}>
                  <Box /> Sandbox
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                asChild
                isActive={pathname.startsWith(webhookHref)}
              >
                <Link href={webhookHref}>
                  <Radio /> Webhooks
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                asChild
                isActive={pathname.startsWith(aboutHref)}
              >
                <Link href={aboutHref}>
                  <Info /> About
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
    </SidebarContent>
  );
}
