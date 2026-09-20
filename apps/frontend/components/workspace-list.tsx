"use client";

import { Workspace } from "@platypus/schemas";
import { useAuth, useBackendUrl } from "@/components/auth-provider";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemGroup,
  ItemTitle,
} from "./ui/item";
import useSWR from "swr";
import { cn, fetcher, joinUrl } from "../lib/utils";
import { ChevronRight, FolderClosed } from "lucide-react";
import Link from "next/link";
import { Skeleton } from "@/components/ui/skeleton";
import { workspaceRoutes } from "@/lib/routes";

const WorkspaceList = ({
  className,
  orgId,
}: {
  className?: string;
  orgId: string;
}) => {
  const { user } = useAuth();
  const backendUrl = useBackendUrl();

  const { data, error, isLoading } = useSWR<{ results: Workspace[] }>(
    backendUrl && user
      ? joinUrl(backendUrl, `/organizations/${orgId}/workspaces`)
      : null,
    fetcher,
  );

  if (error) return null;

  if (isLoading || !data) {
    return (
      <ItemGroup className={cn("mb-4", className)}>
        {Array.from({ length: 3 }).map((_, i) => (
          <Item key={i} variant="outline" className="mb-2">
            <ItemContent>
              <ItemTitle>
                <Skeleton className="size-4 shrink-0 rounded" />
                <Skeleton className="h-4 w-40 rounded" />
              </ItemTitle>
            </ItemContent>
            <ItemActions>
              <Skeleton className="size-4 rounded" />
            </ItemActions>
          </Item>
        ))}
      </ItemGroup>
    );
  }

  return (
    <ItemGroup className={cn("mb-4", className)}>
      {(data?.results || [])
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((workspace) => (
          <Item key={workspace.id} variant="outline" asChild className="mb-2">
            <Link href={workspaceRoutes(orgId, workspace.id).root}>
              <ItemContent>
                <ItemTitle>
                  <FolderClosed size={18} /> {workspace.name}
                </ItemTitle>
              </ItemContent>
              <ItemActions>
                <ChevronRight className="size-4" />
              </ItemActions>
            </Link>
          </Item>
        ))}
    </ItemGroup>
  );
};

export { WorkspaceList };
