"use client";

import { Workspace } from "@platypus/schemas";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemGroup,
  ItemTitle,
} from "./ui/item";
import { cn } from "../lib/utils";
import { useScopedSWR } from "@/hooks/use-scoped-swr";
import { ChevronRight, FolderClosed } from "lucide-react";
import Link from "next/link";
import { Skeleton } from "@/components/ui/skeleton";
import { ListError } from "@/components/list-state";
import { workspaceRoutes } from "@/lib/routes";

const WorkspaceList = ({
  className,
  orgId,
}: {
  className?: string;
  orgId: string;
}) => {
  const { data, error, isLoading } = useScopedSWR<{ results: Workspace[] }>(
    "workspaces",
    { orgId },
  );

  // Only a cold failure replaces the list; a failed revalidation keeps it.
  if (error && !data) {
    return <ListError error={error} subject="workspaces" />;
  }

  if (isLoading || !data) {
    return (
      <ItemGroup className={cn("mb-4", className)}>
        {Array.from({ length: 3 }).map((_, i) => (
          <Item key={i} variant="outline" className="mb-2">
            <ItemContent>
              {/* The 18px folder icon beside one line of title text. */}
              <ItemTitle>
                <Skeleton className="size-[18px] shrink-0 rounded" />
                <span className="flex h-lh items-center">
                  <Skeleton className="h-4 w-40 rounded" />
                </span>
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
