"use client";

import {
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenu,
} from "@/components/ui/sidebar";
import { User, ShieldCheck, Mail } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

export function UserSettingsMenu() {
  const pathname = usePathname();
  const profileHref = `/settings`;
  const securityHref = `/settings/security`;
  const invitationsHref = `/settings/invitations`;

  return (
    <SidebarContent>
      <SidebarGroup>
        <SidebarGroupContent>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton asChild isActive={pathname === profileHref}>
                <Link href={profileHref}>
                  <User /> Profile
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton asChild isActive={pathname === securityHref}>
                <Link href={securityHref}>
                  <ShieldCheck /> Security
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                asChild
                isActive={pathname === invitationsHref}
              >
                <Link href={invitationsHref}>
                  <Mail /> Invitations
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
    </SidebarContent>
  );
}
