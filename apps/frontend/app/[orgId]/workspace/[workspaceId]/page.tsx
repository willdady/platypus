"use client";

import { AgentsList } from "@/components/agents-list";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  Bot,
  MessageSquare,
  Settings,
  Plus,
  BotMessageSquare,
  FolderOpen,
} from "lucide-react";
import Link from "next/link";
import useSWR from "swr";
import { fetcher } from "@/lib/utils";
import { useBackendUrl } from "@/app/client-context";
import {
  type Workspace as WorkspaceType,
  type Organisation,
} from "@agent-kit/schemas";
import { useParams } from "next/navigation";

const Workspace = () => {
  const params = useParams();
  const orgId = params.orgId as string;
  const workspaceId = params.workspaceId as string;
  const backendUrl = useBackendUrl();

  const { data: workspaceData, isLoading: isLoadingWorkspace } = useSWR<WorkspaceType>(
    `${backendUrl}/workspaces/${workspaceId}`,
    fetcher,
  );

  const { data: agentsData, isLoading: isLoadingAgents } = useSWR<{
    results: [];
  }>(`${backendUrl}/agents?workspaceId=${workspaceId}`, fetcher);

  const { data: chatsData, isLoading: isLoadingChats } = useSWR<{
    results: [];
  }>(`${backendUrl}/chat?workspaceId=${workspaceId}`, fetcher);

  const { data: providersData, isLoading: isLoadingProviders } = useSWR<{
    results: [];
  }>(`${backendUrl}/providers?workspaceId=${workspaceId}`, fetcher);

  const { data: orgData, isLoading: isLoadingOrg } = useSWR<Organisation>(
    `${backendUrl}/organisations/${orgId}`,
    fetcher,
  );

  if (
    isLoadingWorkspace ||
    isLoadingAgents ||
    isLoadingChats ||
    isLoadingProviders ||
    isLoadingOrg
  ) {
    return <div>Loading...</div>;
  }

  if (!workspaceData) {
    return <div>Workspace not found</div>;
  }

  const workspace = workspaceData;
  const agentCount = agentsData?.results?.length || 0;
  const chatCount = chatsData?.results?.length || 0;
  const providerCount = providersData?.results?.length || 0;

  return (
    <div className="flex flex-col gap-8 p-8 max-w-6xl mx-auto">
      {/* Header Section */}
      <div className="flex flex-col">
        <span className="text-sm font-medium text-muted-foreground mb-1">
          {orgData?.name}
        </span>
        <div className="flex items-center gap-3">
          <FolderOpen className="size-8" />
          <h1 className="text-3xl font-bold tracking-tight">
            {workspace.name}
          </h1>
        </div>
      </div>

      {/* Stats Overview */}
      <div className="grid gap-4 md:grid-cols-3">
        <Card className="gap-2">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-0">
            <CardTitle className="text-sm font-medium">Total Agents</CardTitle>
            <Bot className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{agentCount}</div>
            <p className="text-xs text-muted-foreground">
              Active AI assistants
            </p>
          </CardContent>
        </Card>
        <Card className="gap-2">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-0">
            <CardTitle className="text-sm font-medium">Total Chats</CardTitle>
            <MessageSquare className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{chatCount}</div>
            <p className="text-xs text-muted-foreground">
              Conversations started
            </p>
          </CardContent>
        </Card>
        <Card className="gap-2">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-0">
            <CardTitle className="text-sm font-medium">Providers</CardTitle>
            <Settings className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{providerCount}</div>
            <p className="text-xs text-muted-foreground">
              Configured model providers
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Quick Actions */}
      <div className="flex gap-4">
        <Button asChild>
          <Link href={`/${orgId}/workspace/${workspaceId}/chat`}>
            <BotMessageSquare /> New Chat
          </Link>
        </Button>
        <Button variant="outline" asChild>
          <Link href={`/${orgId}/workspace/${workspaceId}/settings/providers`}>
            <Settings /> Configure Providers
          </Link>
        </Button>
      </div>

      <Separator />

      {/* Agents List Section */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-semibold tracking-tight">Your Agents</h2>
        </div>
        {/* Reusing the existing AgentsList component which handles empty states */}
        <AgentsList orgId={orgId} workspaceId={workspaceId} />
        <Button variant="outline" asChild>
          <Link href={`/${orgId}/workspace/${workspaceId}/agents/create`}>
            <Plus /> Create Agent
          </Link>
        </Button>
      </div>
    </div>
  );
};

export default Workspace;
