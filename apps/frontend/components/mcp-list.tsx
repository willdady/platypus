"use client";

import { MCP } from "@agent-kit/schemas";
import { Item, ItemActions, ItemContent, ItemTitle } from "./ui/item";
import useSWR from "swr";
import { cn, fetcher } from "../lib/utils";
import { Pencil } from "lucide-react";
import Link from "next/link";

const McpList = ({
  className,
  orgId,
  workspaceId,
}: {
  className?: string;
  orgId: string;
  workspaceId: string;
}) => {
  const { data, error, isLoading } = useSWR<{ results: MCP[] }>(
    `${process.env.NEXT_PUBLIC_BACKEND_URL}/mcps`,
    fetcher,
  );

  if (isLoading || error) return null; // FIXME

  return (
    <ul className={cn("mb-4", className)}>
      {data?.results.map((mcp) => (
        <li key={mcp.id}>
          <Item variant="outline" asChild>
            <Link
              href={`/${orgId}/workspace/${workspaceId}/settings/mcp/${mcp.id}`}
            >
              <ItemContent>
                <ItemTitle>{mcp.name}</ItemTitle>
              </ItemContent>
              <ItemActions>
                <Pencil className="size-4" />
              </ItemActions>
            </Link>
          </Item>
        </li>
      ))}
    </ul>
  );
};

export { McpList };
