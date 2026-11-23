"use client";

import {
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenu,
} from "@/components/ui/sidebar";
import type { SettingsNavLink } from "@/lib/settings-links";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

type SettingsNavMenuProps = {
  links: SettingsNavLink[];
  /** Rendered above the links, inside the same sidebar group. */
  children?: ReactNode;
};

export function SettingsNavMenu({ links, children }: SettingsNavMenuProps) {
  const pathname = usePathname();

  return (
    <SidebarContent>
      <SidebarGroup>
        {children}
        <SidebarGroupContent>
          <SidebarMenu>
            {links.map(({ href, icon: Icon, label, exact }) => (
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
            ))}
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
    </SidebarContent>
  );
}
