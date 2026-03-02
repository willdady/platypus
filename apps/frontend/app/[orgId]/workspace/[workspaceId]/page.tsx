"use client";

import { AgentsList } from "@/components/agents-list";
import { SkillsList } from "@/components/skills-list";
import { ScheduleList } from "@/components/schedule-list";
import { BoardsList } from "@/components/boards-list";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  Bot,
  MessageSquare,
  Plus,
  BotMessageSquare,
  FolderOpen,
  Sparkles,
  Timer,
  KanbanSquare,
} from "lucide-react";
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
import { TagCloud } from "@/components/tag-cloud";
import { useChatFilter } from "@/hooks/use-chat-filter";

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

  const { data: schedulesData, isLoading: isLoadingSchedules } = useSWR<{
    results: [];
  }>(
    backendUrl && user
      ? joinUrl(
          backendUrl,
          `/organizations/${orgId}/workspaces/${workspaceId}/schedules`,
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

  const { data: orgData, isLoading: isLoadingOrg } = useSWR<Organization>(
    backendUrl && user ? joinUrl(backendUrl, `/organizations/${orgId}`) : null,
    fetcher,
  );

  const { selectedTags, toggleFilterTag } = useChatFilter();

  if (
    isLoadingWorkspace ||
    isLoadingAgents ||
    isLoadingChats ||
    isLoadingProviders ||
    isLoadingSkills ||
    isLoadingSchedules ||
    isLoadingBoards ||
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
  const skillCount = skillsData?.results?.length || 0;
  const scheduleCount = schedulesData?.results?.length || 0;
  const boardCount = boardsData?.results?.length || 0;

  return (
    <div className="flex flex-col gap-8 p-8 pb-32 max-w-6xl mx-auto">
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

      {providerCount === 0 ? (
        <NoProvidersEmptyState orgId={orgId} workspaceId={workspaceId} />
      ) : (
        <>
          {/* Stats Overview */}
          <div className="grid gap-4 md:grid-cols-5">
            <Card className="gap-2">
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-0">
                <CardTitle className="text-sm font-medium">
                  Total Chats
                </CardTitle>
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
                <CardTitle className="text-sm font-medium">
                  Total Agents
                </CardTitle>
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
                <CardTitle className="text-sm font-medium">
                  Total Skills
                </CardTitle>
                <Sparkles className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{skillCount}</div>
                <p className="text-xs text-muted-foreground">
                  Reusable instruction sets
                </p>
              </CardContent>
            </Card>
            <Card className="gap-2">
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-0">
                <CardTitle className="text-sm font-medium">
                  Total Schedules
                </CardTitle>
                <Timer className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{scheduleCount}</div>
                <p className="text-xs text-muted-foreground">
                  Automated agent runs
                </p>
              </CardContent>
            </Card>
            <Card className="gap-2">
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-0">
                <CardTitle className="text-sm font-medium">
                  Total Boards
                </CardTitle>
                <KanbanSquare className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{boardCount}</div>
                <p className="text-xs text-muted-foreground">
                  Visual work management
                </p>
              </CardContent>
            </Card>
          </div>

          <TagCloud
            orgId={orgId}
            workspaceId={workspaceId}
            selectedTags={selectedTags}
            onTagToggle={toggleFilterTag}
          />

          <Separator />

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
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex flex-col">
                <h2 className="text-xl font-semibold tracking-tight flex items-center gap-2">
                  <Sparkles className="size-5" /> Skills
                </h2>
                <p className="text-sm text-muted-foreground">
                  Reusable instruction sets that help agents perform specific
                  tasks.
                </p>
              </div>
            </div>
            <SkillsList orgId={orgId} workspaceId={workspaceId} />
            <Button variant="outline" asChild>
              <Link href={`/${orgId}/workspace/${workspaceId}/skills/create`}>
                <Plus /> Create Skill
              </Link>
            </Button>
          </div>

          <Separator />

          {/* Boards List Section */}
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex flex-col">
                <h2 className="text-xl font-semibold tracking-tight flex items-center gap-2">
                  <KanbanSquare className="size-5" /> Boards
                </h2>
                <p className="text-sm text-muted-foreground">
                  Visual work management boards for organizing tasks.
                </p>
              </div>
            </div>
            <BoardsList orgId={orgId} workspaceId={workspaceId} />
            <Button variant="outline" asChild>
              <Link href={`/${orgId}/workspace/${workspaceId}/boards/create`}>
                <Plus /> Create Board
              </Link>
            </Button>
          </div>

          <Separator />

          {/* Schedules List Section */}
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex flex-col">
                <h2 className="text-xl font-semibold tracking-tight flex items-center gap-2">
                  <Timer className="size-5" /> Schedules
                </h2>
                <p className="text-sm text-muted-foreground">
                  Automated agent runs configured for this workspace.
                </p>
              </div>
            </div>
            <ScheduleList orgId={orgId} workspaceId={workspaceId} />
            <Button variant="outline" asChild>
              <Link
                href={`/${orgId}/workspace/${workspaceId}/schedules/create`}
              >
                <Plus /> Create Schedule
              </Link>
            </Button>
          </div>
        </>
      )}
    </div>
  );
};

export default Workspace;
