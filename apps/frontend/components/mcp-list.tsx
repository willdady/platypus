"use client";

import { MCP } from "@platypus/schemas";
import { Item, ItemActions, ItemContent, ItemTitle } from "./ui/item";
import useSWR from "swr";
import { cn, fetcher } from "../lib/utils";
import { Pencil, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert";
import { useBackendUrl } from "@/app/client-context";

const McpList = ({
  className,
  orgId,
  workspaceId,
}: {
  className?: string;
  orgId: string;
  workspaceId: string;
}) => {
  const backendUrl = useBackendUrl();

  const { data, error, isLoading } = useSWR<{ results: MCP[] }>(
    `${backendUrl}/mcps?workspaceId=${workspaceId}`,
    fetcher,
  );

  if (isLoading || error) return null; // FIXME

  const mcps: MCP[] = data?.results ?? [];
  if (!mcps.length) {
    return (
      <Alert className="w-full mb-4">
        <TriangleAlert />
        <AlertTitle>No MCP servers configured</AlertTitle>
        <AlertDescription>
          <p>There are currently no MCP servers configured.</p>
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <ul className={cn("mb-4", className)}>
      {mcps.map((mcp) => (
        <li key={mcp.id} className="mb-2">
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
