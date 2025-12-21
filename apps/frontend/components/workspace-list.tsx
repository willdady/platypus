"use client";

import { Workspace } from "@platypus/schemas";
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
import { useBackendUrl } from "@/app/client-context";

const WorkspaceList = ({
  className,
  orgId,
}: {
  className?: string;
  orgId: string;
}) => {
  const backendUrl = useBackendUrl();

  const { data, error, isLoading } = useSWR<{ results: Workspace[] }>(
    backendUrl ? joinUrl(backendUrl, `/workspaces?orgId=${orgId}`) : null,
    fetcher,
  );

  if (isLoading || error) return null; // FIXME

  return (
    <ItemGroup className={cn("mb-4", className)}>
      {data?.results.map((workspace) => (
        <Item key={workspace.id} variant="outline" asChild className="mb-2">
          <Link href={`/${orgId}/workspace/${workspace.id}`}>
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
