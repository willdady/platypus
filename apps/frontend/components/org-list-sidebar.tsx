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
import useSWR, { preload } from "swr";
import { useEffect } from "react";
import { fetcher, joinUrl } from "@/lib/utils";
import { useBackendUrl } from "@/app/client-context";
import { useAuth } from "@/components/auth-provider";
import { Skeleton } from "@/components/ui/skeleton";
import type { Organization } from "@platypus/schemas";

interface OrgListSidebarProps {
  currentOrgId: string;
}

export function OrgListSidebar({ currentOrgId }: OrgListSidebarProps) {
  const { user } = useAuth();
  const backendUrl = useBackendUrl();

  const { data } = useSWR<{ results: Organization[] }>(
    backendUrl && user ? joinUrl(backendUrl, "/organizations") : null,
    fetcher,
  );

  const isReady = !!data;

  const organizations = (data?.results || []).sort((a, b) =>
    a.name.localeCompare(b.name),
  );

  // Eagerly preload workspaces for all orgs so switching feels instant
  useEffect(() => {
    if (!backendUrl || !data?.results) return;
    for (const org of data.results) {
      preload(
        joinUrl(backendUrl, `/organizations/${org.id}/workspaces`),
        fetcher,
      );
    }
  }, [backendUrl, data]);

  return (
    <SidebarContent>
      <SidebarGroup>
        <SidebarGroupContent>
          <SidebarMenu>
            {!isReady
              ? Array.from({ length: 3 }).map((_, i) => (
                  <SidebarMenuItem key={i}>
                    <div className="flex h-8 items-center gap-2 rounded-md px-2">
                      <Skeleton className="size-4 shrink-0" />
                      <Skeleton className="h-4 flex-1" />
                    </div>
                  </SidebarMenuItem>
                ))
              : organizations.map((org) => (
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
                ))}
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>

      {isReady && (
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton asChild>
                  <Link href="/create">
                    <Plus className="size-4" />
                    <span>Add organization</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      )}
    </SidebarContent>
  );
}
