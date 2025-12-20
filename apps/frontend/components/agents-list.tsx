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
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  BotMessageSquare,
  EllipsisVertical,
  Pencil,
  Plus,
  TriangleAlert,
} from "lucide-react";
import { type Agent, type Provider } from "@agent-kit/schemas";
import useSWR from "swr";
import { fetcher } from "@/lib/utils";
import Link from "next/link";
import { useBackendUrl } from "@/app/client-context";
import { NoProvidersAlert } from "@/components/no-providers-alert";

export const AgentsList = ({
  orgId,
  workspaceId,
}: {
  orgId: string;
  workspaceId: string;
}) => {
  const backendUrl = useBackendUrl();

  const { data: agentsData, isLoading: isLoadingAgents } = useSWR<{
    results: Agent[];
  }>(`${backendUrl}/agents?workspaceId=${workspaceId}`, fetcher);

  const { data: providersData, isLoading: isLoadingProviders } = useSWR<{
    results: Provider[];
  }>(`${backendUrl}/providers?workspaceId=${workspaceId}`, fetcher);

  const agents = agentsData?.results || [];
  const providers = providersData?.results || [];

  if (isLoadingAgents || isLoadingProviders) {
    return <div>Loading...</div>;
  }

  if (!providers.length) {
    return (
      <div className="h-[calc(100vh-2.75rem)]">
        <NoProvidersAlert orgId={orgId} workspaceId={workspaceId} />
      </div>
    );
  }

  if (!agents.length) {
    return (
      <div className="flex items-center justify-center h-[calc(100vh-2.75rem)]">
        <Alert className="min-w-sm max-w-md">
          <TriangleAlert />
          <AlertTitle>No agents configured</AlertTitle>
          <AlertDescription>
            <p className="mb-2">Start by creating your first agent.</p>
            <Button size="sm" asChild>
              <Link href={`/${orgId}/workspace/${workspaceId}/agents/create`}>
                <Plus /> Add agent
              </Link>
            </Button>
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <ul className="grid grid-cols-1 lg:grid-cols-2 grid-rows-1 gap-4">
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
