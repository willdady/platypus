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
import { preload } from "swr";
import { useEffect } from "react";
import { fetcher } from "@/lib/utils";
import { useBackendUrl } from "@/components/auth-provider";
import { useScopedList } from "@/hooks/use-scoped-list";
import { scopedUrl } from "@/lib/api-write";
import { Skeleton } from "@/components/ui/skeleton";
import type { Organization } from "@platypus/schemas";
import { appRoutes, orgRoutes } from "@/lib/routes";

interface OrgListSidebarProps {
  currentOrgId: string;
}

export function OrgListSidebar({ currentOrgId }: OrgListSidebarProps) {
  const backendUrl = useBackendUrl();

  const { data, results, error } = useScopedList<Organization>(
    "organizations",
    {},
  );

  // A failed read settles the list too; gating on data alone left a failed
  // one pulsing forever.
  const isReady = !!data || !!error;

  const organizations = [...results].sort((a, b) =>
    a.name.localeCompare(b.name),
  );

  // Eagerly preload workspaces for all orgs so switching feels instant
  useEffect(() => {
    if (!backendUrl) return;
    for (const org of results) {
      // A failed prefetch resurfaces as the list's own error once it mounts.
      preload(
        scopedUrl(backendUrl, "workspaces", { orgId: org.id }),
        fetcher,
      ).catch(() => {});
    }
  }, [backendUrl, results]);

  return (
    <SidebarContent>
      <SidebarGroup>
        <SidebarGroupContent>
          <SidebarMenu>
            {!isReady ? (
              Array.from({ length: 3 }).map((_, i) => (
                <SidebarMenuItem key={i}>
                  <div className="flex h-8 items-center gap-2 rounded-md px-2">
                    <Skeleton className="size-4 shrink-0" />
                    <Skeleton className="h-4 flex-1" />
                  </div>
                </SidebarMenuItem>
              ))
            ) : error && !data ? (
              <SidebarMenuItem>
                <p className="px-2 py-1.5 text-sm text-destructive">
                  Couldn&apos;t load organizations.
                </p>
              </SidebarMenuItem>
            ) : (
              organizations.map((org) => (
                <SidebarMenuItem key={org.id}>
                  <SidebarMenuButton asChild isActive={currentOrgId === org.id}>
                    <Link href={orgRoutes(org.id).root}>
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

      {/* Drawn as a placeholder while loading, so it doesn't pop in below
        the list once the list arrives. */}
      <SidebarGroup>
        <SidebarGroupContent>
          <SidebarMenu>
            <SidebarMenuItem>
              {isReady ? (
                <SidebarMenuButton asChild>
                  <Link href={appRoutes.createOrganization}>
                    <Plus className="size-4" />
                    <span>Add organization</span>
                  </Link>
                </SidebarMenuButton>
              ) : (
                <div className="flex h-8 items-center gap-2 rounded-md px-2">
                  <Skeleton className="size-4 shrink-0" />
                  <Skeleton className="h-4 w-28" />
                </div>
              )}
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
    </SidebarContent>
  );
}
