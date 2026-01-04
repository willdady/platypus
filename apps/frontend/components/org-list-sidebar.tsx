"use client";

import {
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { Building, Plus } from "lucide-react";
import Link from "next/link";
import useSWR from "swr";
import { fetcher, joinUrl } from "@/lib/utils";
import { useBackendUrl } from "@/app/client-context";
import { useAuth } from "@/components/auth-provider";
import type { Organization } from "@platypus/schemas";

interface OrgListSidebarProps {
  currentOrgId: string;
}

export function OrgListSidebar({ currentOrgId }: OrgListSidebarProps) {
  const { user } = useAuth();
  const backendUrl = useBackendUrl();

  const { data, isLoading } = useSWR<{ results: Organization[] }>(
    backendUrl && user ? joinUrl(backendUrl, "/organizations") : null,
    fetcher,
  );

  const organizations = (data?.results || []).sort((a, b) => a.name.localeCompare(b.name));

  return (
    <SidebarContent>
      <SidebarGroup>
        <SidebarGroupContent>
          <SidebarMenu>
            {isLoading ? (
              <div className="px-4 py-2 text-sm text-muted-foreground animate-pulse">
                Loading organizations...
              </div>
            ) : (
              organizations.map((org) => (
                <SidebarMenuItem key={org.id}>
                  <SidebarMenuButton
                    asChild
                    isActive={currentOrgId === org.id}
                    className="cursor-pointer"
                  >
                    <Link href={`/${org.id}`}>
                      <Building className="size-4" />
                      <span>{org.name}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))
            )}
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>

      <SidebarGroup>
        <SidebarGroupContent>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton asChild>
                <Link href="/create">
                  <Plus className="size-4" />
                  <span>Add Organization</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
    </SidebarContent>
  );
}
