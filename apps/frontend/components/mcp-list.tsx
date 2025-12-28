"use client";

import { MCP } from "@platypus/schemas";
import { Item, ItemActions, ItemContent, ItemTitle } from "./ui/item";
import useSWR from "swr";
import { cn, fetcher, joinUrl } from "../lib/utils";
import { useAuth } from "@/components/auth-provider";
import { Pencil, Plus } from "lucide-react";
import Link from "next/link";
import { useBackendUrl } from "@/app/client-context";
import { NoMcpEmptyState } from "./no-mcp-empty-state";
import { Button } from "./ui/button";

const McpList = ({
  className,
  orgId,
  workspaceId,
}: {
  className?: string;
  orgId: string;
  workspaceId: string;
}) => {
  const { user } = useAuth();
  const backendUrl = useBackendUrl();

  const { data, error, isLoading } = useSWR<{ results: MCP[] }>(
    backendUrl && user
      ? joinUrl(
          backendUrl,
          `/organizations/${orgId}/workspaces/${workspaceId}/mcps`,
        )
      : null,
    fetcher,
  );

  if (isLoading || error) return null; // FIXME

  const mcps: MCP[] = data?.results ?? [];
  if (!mcps.length) {
    return <NoMcpEmptyState orgId={orgId} workspaceId={workspaceId} />;
  }

  return (
    <>
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
      <Button asChild>
        <Link href={`/${orgId}/workspace/${workspaceId}/settings/mcp/create`}>
          <Plus /> Add MCP
        </Link>
      </Button>
    </>
  );
};

export { McpList };
