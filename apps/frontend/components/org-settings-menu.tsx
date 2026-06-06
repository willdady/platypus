"use client";

import {
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenu,
} from "@/components/ui/sidebar";
import {
  Bot,
  Layers,
  Mail,
  Plug,
  Settings,
  Sparkles,
  Unplug,
  Users,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

interface OrgSettingsMenuProps {
  orgId: string;
}

export function OrgSettingsMenu({ orgId }: OrgSettingsMenuProps) {
  const pathname = usePathname();
  const generalHref = `/${orgId}/settings`;
  const membersHref = `/${orgId}/settings/members`;
  const invitationsHref = `/${orgId}/settings/invitations`;
  const providersHref = `/${orgId}/settings/providers`;
  const mcpHref = `/${orgId}/settings/mcp`;
  const skillsHref = `/${orgId}/settings/skills`;
  const agentsHref = `/${orgId}/settings/agents`;
  const blueprintsHref = `/${orgId}/settings/blueprints`;

  return (
    <SidebarContent>
      <SidebarGroup>
        <SidebarGroupContent>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton asChild isActive={pathname === generalHref}>
                <Link href={generalHref}>
                  <Settings /> General
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                asChild
                isActive={pathname.startsWith(membersHref)}
              >
                <Link href={membersHref}>
                  <Users /> Members
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                asChild
                isActive={pathname.startsWith(invitationsHref)}
              >
                <Link href={invitationsHref}>
                  <Mail /> Invitations
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
                  <Plug /> MCP
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                asChild
                isActive={pathname.startsWith(skillsHref)}
              >
                <Link href={skillsHref}>
                  <Sparkles /> Skills
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                asChild
                isActive={pathname.startsWith(agentsHref)}
              >
                <Link href={agentsHref}>
                  <Bot /> Agents
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                asChild
                isActive={pathname.startsWith(blueprintsHref)}
              >
                <Link href={blueprintsHref}>
                  <Layers /> Blueprints
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
    </SidebarContent>
  );
}
