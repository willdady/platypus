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
import { useAuth } from "@/components/auth-provider";
import { isOperator } from "@/lib/authorization";
import { userSettingsLinks } from "@/lib/settings-links";

export function UserSettingsMenu() {
  const pathname = usePathname();
  const { actor } = useAuth();

  return (
    <SidebarContent>
      <SidebarGroup>
        <SidebarGroupContent>
          <SidebarMenu>
            {userSettingsLinks(isOperator(actor)).map(
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
