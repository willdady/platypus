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

interface SettingsMenuProps {
  orgId: string;
  workspaceId: string;
}

export function SettingsMenu({ orgId, workspaceId }: SettingsMenuProps) {
  const pathname = usePathname();
  const providersHref = `/${orgId}/workspace/${workspaceId}/settings/providers`;

  return (
    <SidebarContent>
      <SidebarGroup>
        <SidebarGroupContent>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton asChild isActive={pathname === providersHref}>
                <Link href={providersHref}>
                  {/* <item.icon /> */}
                  <span>Providers</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
    </SidebarContent>
  );
}
