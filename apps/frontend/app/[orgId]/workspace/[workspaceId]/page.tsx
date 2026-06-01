"use client";

import { AgentsList } from "@/components/agents-list";
import { SkillsList } from "@/components/skills-list";
import { TriggerList } from "@/components/trigger-list";
import { BoardsList } from "@/components/boards-list";
import { DashboardsList } from "@/components/dashboards-list";
import { CollapsibleSection } from "@/components/collapsible-section";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  Bot,
  MessageSquare,
  Plus,
  FolderOpen,
  Settings,
  Sparkles,
  Zap,
  KanbanSquare,
  LayoutDashboard,
} from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import Link from "next/link";
import useSWR from "swr";
import { fetcher, joinUrl } from "@/lib/utils";
import { NoProvidersEmptyState } from "@/components/no-providers-empty-state";
import { useBackendUrl } from "@/app/client-context";
import { useAuth } from "@/components/auth-provider";
import {
  type Workspace as WorkspaceType,
  type Organization,
} from "@platypus/schemas";
import { useParams } from "next/navigation";

const Workspace = () => {
  const params = useParams();
  const orgId = params.orgId as string;
  const workspaceId = params.workspaceId as string;
  const { user } = useAuth();
  const backendUrl = useBackendUrl();

  const { data: workspaceData, isLoading: isLoadingWorkspace } =
    useSWR<WorkspaceType>(
      backendUrl && user
        ? joinUrl(
            backendUrl,
            `/organizations/${orgId}/workspaces/${workspaceId}`,
          )
        : null,
      fetcher,
    );

  const { data: agentsData, isLoading: isLoadingAgents } = useSWR<{
    results: [];
  }>(
    backendUrl && user
      ? joinUrl(
          backendUrl,
          `/organizations/${orgId}/workspaces/${workspaceId}/agents`,
        )
      : null,
    fetcher,
  );

  const { data: chatsData, isLoading: isLoadingChats } = useSWR<{
    results: [];
    totalCount: number;
  }>(
    backendUrl && user
      ? joinUrl(
          backendUrl,
          `/organizations/${orgId}/workspaces/${workspaceId}/chat`,
        )
      : null,
    fetcher,
  );

  const { data: providersData, isLoading: isLoadingProviders } = useSWR<{
    results: [];
  }>(
    backendUrl && user
      ? joinUrl(
          backendUrl,
          `/organizations/${orgId}/workspaces/${workspaceId}/providers`,
        )
      : null,
    fetcher,
  );

  const { data: skillsData, isLoading: isLoadingSkills } = useSWR<{
    results: [];
  }>(
    backendUrl && user
      ? joinUrl(
          backendUrl,
          `/organizations/${orgId}/workspaces/${workspaceId}/skills`,
        )
      : null,
    fetcher,
  );

  const { data: triggersData, isLoading: isLoadingTriggers } = useSWR<{
    results: [];
  }>(
    backendUrl && user
      ? joinUrl(
          backendUrl,
          `/organizations/${orgId}/workspaces/${workspaceId}/triggers`,
        )
      : null,
    fetcher,
  );

  const { data: boardsData, isLoading: isLoadingBoards } = useSWR<{
    results: [];
  }>(
    backendUrl && user
      ? joinUrl(
          backendUrl,
          `/organizations/${orgId}/workspaces/${workspaceId}/boards`,
        )
      : null,
    fetcher,
  );

  const { data: dashboardsData, isLoading: isLoadingDashboards } = useSWR<{
    results: [];
  }>(
    backendUrl && user
      ? joinUrl(
          backendUrl,
          `/organizations/${orgId}/workspaces/${workspaceId}/dashboards`,
        )
      : null,
    fetcher,
  );

  const { data: orgData, isLoading: isLoadingOrg } = useSWR<Organization>(
    backendUrl && user ? joinUrl(backendUrl, `/organizations/${orgId}`) : null,
    fetcher,
  );

  if (
    !backendUrl ||
    !user ||
    isLoadingWorkspace ||
    isLoadingAgents ||
    isLoadingChats ||
    isLoadingProviders ||
    isLoadingSkills ||
    isLoadingTriggers ||
    isLoadingBoards ||
    isLoadingDashboards ||
    isLoadingOrg
  ) {
    return (
      <div className="flex flex-col gap-8 px-4 md:px-8 py-8 pb-32 max-w-6xl mx-auto">
        {/* Header */}
        <div className="flex flex-col">
          <Skeleton className="h-4 w-24 mb-1" />
          <div className="flex items-center gap-3">
            <Skeleton className="size-8 rounded" />
            <Skeleton className="h-9 w-48" />
          </div>
        </div>

        {/* Stats Cards - mobile */}
        <div className="flex gap-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden pb-1 lg:hidden">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-9 w-24 min-w-fit rounded-xl" />
          ))}
        </div>
        {/* Stats Cards - desktop */}
        <div className="hidden lg:grid gap-4 grid-cols-6">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-[104px] w-full rounded-xl" />
          ))}
        </div>

        {/* Agents Section */}
        <div className="space-y-4">
          <div className="flex flex-col">
            <Skeleton className="h-6 w-32 mb-1" />
            <Skeleton className="h-4 w-64" />
          </div>
          <div className="space-y-2">
            <Skeleton className="h-16 w-full rounded-lg" />
            <Skeleton className="h-16 w-full rounded-lg" />
          </div>
        </div>

        <Separator />

        {/* Skills Section */}
        <div className="space-y-4">
          <div className="flex flex-col">
            <Skeleton className="h-6 w-28 mb-1" />
            <Skeleton className="h-4 w-72" />
          </div>
          <div className="space-y-2">
            <Skeleton className="h-16 w-full rounded-lg" />
            <Skeleton className="h-16 w-full rounded-lg" />
          </div>
        </div>

        <Separator />

        {/* Boards Section */}
        <div className="space-y-4">
          <div className="flex flex-col">
            <Skeleton className="h-6 w-28 mb-1" />
            <Skeleton className="h-4 w-64" />
          </div>
          <div className="space-y-2">
            <Skeleton className="h-16 w-full rounded-lg" />
            <Skeleton className="h-16 w-full rounded-lg" />
          </div>
        </div>

        <Separator />

        {/* Triggers Section */}
        <div className="space-y-4">
          <div className="flex flex-col">
            <Skeleton className="h-6 w-32 mb-1" />
            <Skeleton className="h-4 w-64" />
          </div>
          <div className="space-y-2">
            <Skeleton className="h-16 w-full rounded-lg" />
          </div>
        </div>
      </div>
    );
  }

  if (!workspaceData) {
    return <div>Workspace not found</div>;
  }

  const workspace = workspaceData;
  const agentCount = agentsData?.results?.length || 0;
  const chatCount = chatsData?.totalCount ?? 0;
  const providerCount = providersData?.results?.length || 0;
  const skillCount = skillsData?.results?.length || 0;
  const triggerCount = triggersData?.results?.length || 0;
  const boardCount = boardsData?.results?.length || 0;
  const dashboardCount = dashboardsData?.results?.length || 0;

  return (
    <div className="flex flex-col gap-8 px-4 md:px-8 py-8 pb-32 max-w-6xl mx-auto">
      {/* Header Section */}
      <div className="flex flex-col">
        <span className="text-sm font-medium text-muted-foreground mb-1">
          {orgData?.name}
        </span>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <FolderOpen className="size-8" />
            <h1 className="text-3xl font-bold tracking-tight">
              {workspace.name}
            </h1>
          </div>
          <Link
            href={`/${orgId}/workspace/${workspaceId}/settings`}
            aria-label="Workspace settings"
            className="p-2 hover:bg-muted rounded-md transition-colors shrink-0"
          >
            <Settings className="h-5 w-5 text-muted-foreground" />
          </Link>
        </div>
      </div>

      {providerCount === 0 ? (
        <NoProvidersEmptyState orgId={orgId} workspaceId={workspaceId} />
      ) : (
        <>
          {/* Stats Overview - compact on mobile, full cards on desktop */}
          <div className="flex gap-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden pb-1 lg:hidden">
            {[
              { label: "Chats", value: chatCount, icon: MessageSquare },
              { label: "Agents", value: agentCount, icon: Bot },
              { label: "Skills", value: skillCount, icon: Sparkles },
              {
                label: "Dashboards",
                value: dashboardCount,
                icon: LayoutDashboard,
              },
              { label: "Boards", value: boardCount, icon: KanbanSquare },
              { label: "Triggers", value: triggerCount, icon: Zap },
            ].map(({ label, value, icon: Icon }) => (
              <Card
                key={label}
                className="flex flex-row items-center gap-2 px-3 py-2 min-w-fit"
              >
                <Icon className="h-4 w-4 text-muted-foreground shrink-0" />
                <span className="text-lg font-bold">{value}</span>
                <span className="text-xs text-muted-foreground whitespace-nowrap">
                  {label}
                </span>
              </Card>
            ))}
          </div>
          <div className="hidden lg:grid gap-4 grid-cols-6">
            <Card className="gap-2 py-4">
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-0 px-4">
                <CardTitle className="text-sm font-medium">Chats</CardTitle>
                <MessageSquare className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent className="px-4">
                <div className="text-2xl font-bold">{chatCount}</div>
                <p className="text-xs text-muted-foreground">
                  Conversations started
                </p>
              </CardContent>
            </Card>
            <Card className="gap-2 py-4">
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-0 px-4">
                <CardTitle className="text-sm font-medium">Agents</CardTitle>
                <Bot className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent className="px-4">
                <div className="text-2xl font-bold">{agentCount}</div>
                <p className="text-xs text-muted-foreground">
                  Active AI assistants
                </p>
              </CardContent>
            </Card>
            <Card className="gap-2 py-4">
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-0 px-4">
                <CardTitle className="text-sm font-medium">Skills</CardTitle>
                <Sparkles className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent className="px-4">
                <div className="text-2xl font-bold">{skillCount}</div>
                <p className="text-xs text-muted-foreground">
                  Reusable instruction sets
                </p>
              </CardContent>
            </Card>
            <Card className="gap-2 py-4">
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-0 px-4">
                <CardTitle className="text-sm font-medium">
                  Dashboards
                </CardTitle>
                <LayoutDashboard className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent className="px-4">
                <div className="text-2xl font-bold">{dashboardCount}</div>
                <p className="text-xs text-muted-foreground">
                  Widget-based views
                </p>
              </CardContent>
            </Card>
            <Card className="gap-2 py-4">
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-0 px-4">
                <CardTitle className="text-sm font-medium">Boards</CardTitle>
                <KanbanSquare className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent className="px-4">
                <div className="text-2xl font-bold">{boardCount}</div>
                <p className="text-xs text-muted-foreground">
                  Visual work management
                </p>
              </CardContent>
            </Card>
            <Card className="gap-2 py-4">
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-0 px-4">
                <CardTitle className="text-sm font-medium">Triggers</CardTitle>
                <Zap className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent className="px-4">
                <div className="text-2xl font-bold">{triggerCount}</div>
                <p className="text-xs text-muted-foreground">
                  Automated agent runs
                </p>
              </CardContent>
            </Card>
          </div>

          {/* Agents List Section */}
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex flex-col">
                <h2 className="text-xl font-semibold tracking-tight flex items-center gap-2">
                  <Bot className="size-5" /> Agents
                </h2>
                <p className="text-sm text-muted-foreground">
                  Active AI assistants configured for this workspace.
                </p>
              </div>
            </div>
            {/* Reusing the existing AgentsList component which handles empty states */}
            <AgentsList orgId={orgId} workspaceId={workspaceId} />
            <Button variant="outline" asChild>
              <Link href={`/${orgId}/workspace/${workspaceId}/agents/create`}>
                <Plus /> Create Agent
              </Link>
            </Button>
          </div>

          <Separator />

          {/* Skills List Section */}
          <CollapsibleSection
            title={
              <>
                <Sparkles className="size-5" /> Skills
              </>
            }
            description="Reusable instruction sets that help agents perform specific tasks."
            storageKey="section:skills:open"
          >
            <SkillsList orgId={orgId} workspaceId={workspaceId} />
          </CollapsibleSection>

          <Separator />

          {/* Dashboards Section */}
          <CollapsibleSection
            title={
              <>
                <LayoutDashboard className="size-5" /> Dashboards
              </>
            }
            description="Widget-based dashboards for surfacing agent data at a glance."
            storageKey="section:dashboards:open"
          >
            <DashboardsList orgId={orgId} workspaceId={workspaceId} />
            <Button variant="outline" asChild>
              <Link
                href={`/${orgId}/workspace/${workspaceId}/dashboards/create`}
              >
                <Plus /> Create Dashboard
              </Link>
            </Button>
          </CollapsibleSection>

          <Separator />

          {/* Boards List Section */}
          <CollapsibleSection
            title={
              <>
                <KanbanSquare className="size-5" /> Boards
              </>
            }
            description="Visual work management boards for organizing tasks."
            storageKey="section:boards:open"
          >
            <BoardsList orgId={orgId} workspaceId={workspaceId} />
            <Button variant="outline" asChild>
              <Link href={`/${orgId}/workspace/${workspaceId}/boards/create`}>
                <Plus /> Create Board
              </Link>
            </Button>
          </CollapsibleSection>

          <Separator />

          {/* Triggers List Section */}
          <CollapsibleSection
            title={
              <>
                <Zap className="size-5" /> Triggers
              </>
            }
            description="Automated agent runs configured for this workspace."
            storageKey="section:triggers:open"
          >
            <TriggerList orgId={orgId} workspaceId={workspaceId} />
            <Button variant="outline" asChild>
              <Link href={`/${orgId}/workspace/${workspaceId}/triggers/create`}>
                <Plus /> Create Trigger
              </Link>
            </Button>
          </CollapsibleSection>
        </>
      )}
    </div>
  );
};

export default Workspace;
