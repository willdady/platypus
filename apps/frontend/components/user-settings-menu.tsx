"use client";

import {
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenu,
} from "@/components/ui/sidebar";
import { User, ShieldCheck, Mail, Users } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuth } from "@/components/auth-provider";

export function UserSettingsMenu() {
  const pathname = usePathname();
  const { user } = useAuth();
  const profileHref = `/settings`;
  const securityHref = `/settings/security`;
  const invitationsHref = `/settings/invitations`;
  const usersHref = `/settings/users`;

  const isSuperAdmin = user?.role === "admin";

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
            {isSuperAdmin && (
              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive={pathname === usersHref}>
                  <Link href={usersHref}>
                    <Users /> Users
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            )}
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
    </SidebarContent>
  );
}
