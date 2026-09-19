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
import { workspaceRoutes } from "@/lib/routes";

interface WorkspaceSettingsMenuProps {
  orgId: string;
  workspaceId: string;
}

export function WorkspaceSettingsMenu({
  orgId,
  workspaceId,
}: WorkspaceSettingsMenuProps) {
  const pathname = usePathname();
  const routes = workspaceRoutes(orgId, workspaceId);
  const workspaceHref = routes.settings.root;
  const providersHref = routes.settings.providers;
  const mcpHref = routes.settings.mcp;
  const sandboxHref = routes.settings.sandbox;
  const webhookHref = routes.settings.webhooks;
  const aboutHref = routes.settings.about;

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
