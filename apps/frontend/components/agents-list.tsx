"use client";

import {
  Item,
  ItemTitle,
  ItemActions,
  ItemDescription,
  ItemContent,
} from "@/components/ui/item";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { BotMessageSquare, EllipsisVertical, Pencil } from "lucide-react";
import { type Agent } from "@agent-kit/schemas";
import useSWR from "swr";
import { fetcher } from "@/lib/utils";
import Link from "next/link";
import { useBackendUrl } from "@/app/client-context";

export const AgentsList = ({
  orgId,
  workspaceId,
}: {
  orgId: string;
  workspaceId: string;
}) => {
  const backendUrl = useBackendUrl();

  const { data, isLoading } = useSWR<{ results: Agent[] }>(
    `${backendUrl}/agents?workspaceId=${workspaceId}`,
    fetcher,
  );

  const agents = data?.results || [];

  if (isLoading) {
    return <div>Loading...</div>;
  }

  return (
    <ul className="grid grid-cols-2 grid-rows-1 gap-4">
      {agents.map((agent) => (
        <li key={agent.id}>
          <Item variant="outline" className="h-full">
            <ItemContent>
              <ItemTitle>{agent.name}</ItemTitle>
              {agent.description && (
                <ItemDescription className="text-xs">
                  {agent.description}
                </ItemDescription>
              )}
            </ItemContent>
            <ItemActions className="gap-1">
              <Button size="sm" asChild>
                <Link
                  href={`/${orgId}/workspace/${workspaceId}/chat?agentId=${agent.id}`}
                >
                  <BotMessageSquare /> New Chat
                </Link>
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    className="cursor-pointer text-muted-foreground"
                    variant="ghost"
                    size="icon"
                  >
                    <EllipsisVertical className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  <DropdownMenuItem asChild>
                    <Link
                      className="cursor-pointer"
                      href={`/${orgId}/workspace/${workspaceId}/agents/${agent.id}`}
                    >
                      <Pencil /> Edit
                    </Link>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </ItemActions>
          </Item>
        </li>
      ))}
    </ul>
  );
};
