"use client";

import {
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenu,
} from "@/components/ui/sidebar";
import { Settings, Users } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

interface OrgSettingsMenuProps {
  orgId: string;
}

export function OrgSettingsMenu({ orgId }: OrgSettingsMenuProps) {
  const pathname = usePathname();
  const generalHref = `/${orgId}/settings`;
  const membersHref = `/${orgId}/settings/members`;

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
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
    </SidebarContent>
  );
}
