"use client";

import { Workspace } from "@agent-kit/schemas";
import { Item, ItemActions, ItemContent, ItemTitle } from "./ui/item";
import useSWR from "swr";
import { cn, fetcher } from "../lib/utils";
import { ChevronRight } from "lucide-react";
import Link from "next/link";

const WorkspaceList = ({
  className,
  orgId,
}: {
  className?: string;
  orgId: string;
}) => {
  const { data, error, isLoading } = useSWR<{ results: Workspace[] }>(
    `${process.env.NEXT_PUBLIC_BACKEND_URL}/workspaces?orgId=${orgId}`,
    fetcher,
  );

  if (isLoading || error) return null; // FIXME

  return (
    <ul className={cn("mb-4", className)}>
      {data?.results.map((workspace) => (
        <li key={workspace.id} className="mb-2">
          <Item variant="outline" asChild>
            <Link href={`/${orgId}/workspace/${workspace.id}`}>
              <ItemContent>
                <ItemTitle>{workspace.name}</ItemTitle>
              </ItemContent>
              <ItemActions>
                <ChevronRight className="size-4" />
              </ItemActions>
            </Link>
          </Item>
        </li>
      ))}
    </ul>
  );
};

export { WorkspaceList };
