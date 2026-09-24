"use client";

import { AgentsList } from "@/components/agents-list";
import { SkillsList } from "@/components/skills-list";
import { TriggerList } from "@/components/trigger-list";
import { BoardsList } from "@/components/boards-list";
import { DashboardsList } from "@/components/dashboards-list";
import {
  CollapsibleSection,
  useSectionOpen,
} from "@/components/collapsible-section";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Item, ItemContent } from "@/components/ui/item";
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
  History,
} from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import Link from "next/link";
import { NoProvidersEmptyState } from "@/components/no-providers-empty-state";
import { useAuth, useBackendUrl } from "@/components/auth-provider";
import { useScopedSWR } from "@/hooks/use-scoped-swr";
import {
  chatListEntity,
  organizationEntity,
  workspaceEntity,
} from "@/lib/api-write";
import {
  type Workspace as WorkspaceType,
  type Organization,
} from "@platypus/schemas";
import { useParams } from "next/navigation";
import { workspaceRoutes } from "@/lib/routes";
import { cn } from "@/lib/utils";

/** Where each collapsible section persists its open state. */
const SECTION_KEYS = {
  skills: "section:skills:open",
  dashboards: "section:dashboards:open",
  boards: "section:boards:open",
  triggers: "section:triggers:open",
} as const;

/**
 * A placeholder for one line of text: a box the line's own height (`h`)
 * holding a shorter bar, which is how a loaded line of text reads.
 */
const TextLine = ({ h, className }: { h: string; className: string }) => (
  <div className={cn("flex items-center", h)}>
    <Skeleton className={className} />
  </div>
);

/** A section heading: the h2 over its one-line description. */
const SectionHeaderSkeleton = ({
  titleWidth,
  descriptionWidth,
}: {
  titleWidth: string;
  descriptionWidth: string;
}) => (
  <div className="flex flex-col">
    <TextLine h="h-7" className={cn("h-6", titleWidth)} />
    <TextLine h="h-5" className={cn("h-4 max-w-full", descriptionWidth)} />
  </div>
);

/** The card grid every section's list renders into. */
const CardGridSkeleton = ({ children }: { children: React.ReactNode }) => (
  <div className="grid grid-cols-1 lg:grid-cols-2 gap-2 lg:gap-4">
    {children}
  </div>
);

/**
 * A collapsible section as it will load: its header and chevron, and — only
 * if the section was last left open — its body. A collapsed section is just
 * the header, so the placeholder doesn't draw a list the page then hides.
 */
const CollapsibleSectionSkeleton = ({
  storageKey,
  titleWidth,
  descriptionWidth,
  children,
}: {
  storageKey: string;
  titleWidth: string;
  descriptionWidth: string;
  children: React.ReactNode;
}) => {
  const open = useSectionOpen(storageKey);
  return (
    <div>
      <div className="flex items-start justify-between gap-2">
        <SectionHeaderSkeleton
          titleWidth={titleWidth}
          descriptionWidth={descriptionWidth}
        />
        <Skeleton className="mt-1 size-5 shrink-0" />
      </div>
      {open && <div className="space-y-4 pt-4">{children}</div>}
    </div>
  );
};

/** An Agent card: avatar, name, a three-line description and the stats. */
const AgentCardSkeleton = () => (
  <Item variant="outline" className="h-full items-stretch">
    <Skeleton className="size-12 shrink-0 rounded-lg" />
    <ItemContent>
      <TextLine h="h-5" className="h-4 w-32" />
      <div>
        <TextLine h="h-4" className="h-3 w-full" />
        <TextLine h="h-4" className="h-3 w-full" />
        <TextLine h="h-4" className="h-3 w-2/3" />
      </div>
      <div className="flex h-4 items-center gap-3">
        <Skeleton className="h-3 w-16" />
        <Skeleton className="h-3 w-12" />
        <Skeleton className="h-3 w-20" />
      </div>
    </ItemContent>
    {/* New chat + menu: beside the content on xl, in a footer below it. */}
    <div className="hidden xl:flex items-center gap-2">
      <Skeleton className="h-8 w-24 rounded-md" />
      <Skeleton className="size-9 rounded-md" />
    </div>
    <div className="flex basis-full items-center justify-between gap-2 pl-16 xl:hidden">
      <Skeleton className="h-8 w-24 rounded-md" />
      <Skeleton className="size-9 rounded-md" />
    </div>
  </Item>
);

/** A Skill, Dashboard or Board card: name, two-line description, menu. */
const EntityCardSkeleton = () => (
  <Item variant="outline" className="h-full">
    <ItemContent>
      <TextLine h="h-5" className="h-4 w-36" />
      <div>
        <TextLine h="h-4" className="h-3 w-full" />
        <TextLine h="h-4" className="h-3 w-1/2" />
      </div>
    </ItemContent>
    <Skeleton className="size-9 rounded-md" />
  </Item>
);

/** A Trigger card: name and type badge, description, Agent and schedule. */
const TriggerCardSkeleton = () => (
  <Item variant="outline" className="h-full">
    <ItemContent>
      <div className="flex items-center gap-2">
        <TextLine h="h-5" className="h-4 w-32" />
        <Skeleton className="h-[22px] w-12 rounded-full" />
      </div>
      <TextLine h="h-4" className="h-3 w-3/4" />
      <TextLine h="h-4 mt-1" className="h-3 w-24" />
      <TextLine h="h-4 mt-1.5" className="h-3 w-40" />
    </ItemContent>
    <Skeleton className="size-9 rounded-md" />
  </Item>
);

/** An outline button in a section's action row. */
const ButtonSkeleton = ({ width }: { width: string }) => (
  <Skeleton className={cn("h-9 rounded-md", width)} />
);

/**
 * The workspace home while its reads are in flight, drawn on the loaded
 * page's frame — header, stat cards, then the five sections in order, each
 * collapsible one collapsed or expanded as it was last left — so the page
 * lands without shifting.
 */
const WorkspaceSkeleton = () => (
  <div
    className="flex flex-col gap-8 px-4 md:px-8 py-8 pb-32 max-w-6xl mx-auto"
    aria-label="Loading workspace"
  >
    {/* Header: org name, then icon + workspace name, settings link */}
    <div className="flex flex-col">
      <TextLine h="h-5 mb-1" className="h-3.5 w-24" />
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Skeleton className="size-8 rounded" />
          <Skeleton className="h-9 w-48" />
        </div>
        <div className="flex size-9 shrink-0 items-center justify-center">
          <Skeleton className="size-5" />
        </div>
      </div>
    </div>

    {/* Stats Cards - mobile */}
    <div className="flex gap-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden pb-1 lg:hidden">
      {Array.from({ length: 6 }).map((_, i) => (
        <Skeleton key={i} className="h-[46px] w-24 shrink-0 rounded-xl" />
      ))}
    </div>
    {/* Stats Cards - desktop */}
    <div className="hidden lg:grid gap-4 grid-cols-6">
      {Array.from({ length: 6 }).map((_, i) => (
        <Skeleton key={i} className="h-[106px] w-full rounded-xl" />
      ))}
    </div>

    {/* Agents Section (not collapsible) */}
    <div className="space-y-4">
      <SectionHeaderSkeleton titleWidth="w-28" descriptionWidth="w-80" />
      <div>
        <CardGridSkeleton>
          <AgentCardSkeleton />
          <AgentCardSkeleton />
        </CardGridSkeleton>
        <div className="mt-4 flex gap-2">
          <ButtonSkeleton width="w-32" />
        </div>
      </div>
    </div>

    <Separator />

    <CollapsibleSectionSkeleton
      storageKey={SECTION_KEYS.skills}
      titleWidth="w-24"
      descriptionWidth="w-96"
    >
      <CardGridSkeleton>
        <EntityCardSkeleton />
        <EntityCardSkeleton />
      </CardGridSkeleton>
      <div className="flex gap-2">
        <ButtonSkeleton width="w-32" />
      </div>
    </CollapsibleSectionSkeleton>

    <Separator />

    <CollapsibleSectionSkeleton
      storageKey={SECTION_KEYS.dashboards}
      titleWidth="w-36"
      descriptionWidth="w-96"
    >
      <CardGridSkeleton>
        <EntityCardSkeleton />
        <EntityCardSkeleton />
      </CardGridSkeleton>
      <ButtonSkeleton width="w-44" />
    </CollapsibleSectionSkeleton>

    <Separator />

    <CollapsibleSectionSkeleton
      storageKey={SECTION_KEYS.boards}
      titleWidth="w-24"
      descriptionWidth="w-80"
    >
      <CardGridSkeleton>
        <EntityCardSkeleton />
        <EntityCardSkeleton />
      </CardGridSkeleton>
      <ButtonSkeleton width="w-36" />
    </CollapsibleSectionSkeleton>

    <Separator />

    <CollapsibleSectionSkeleton
      storageKey={SECTION_KEYS.triggers}
      titleWidth="w-28"
      descriptionWidth="w-80"
    >
      <CardGridSkeleton>
        <TriggerCardSkeleton />
        <TriggerCardSkeleton />
      </CardGridSkeleton>
      <div className="flex flex-wrap gap-2">
        <ButtonSkeleton width="w-36" />
        <ButtonSkeleton width="w-32" />
      </div>
    </CollapsibleSectionSkeleton>
  </div>
);

const Workspace = () => {
  const params = useParams();
  const orgId = params.orgId as string;
  const workspaceId = params.workspaceId as string;
  const routes = workspaceRoutes(orgId, workspaceId);
  const { user } = useAuth();
  const backendUrl = useBackendUrl();

  const { data: workspaceData, isLoading: isLoadingWorkspace } =
    useScopedSWR<WorkspaceType>(workspaceEntity(workspaceId), { orgId });

  const scope = { orgId, workspaceId };

  const { data: agentsData, isLoading: isLoadingAgents } = useScopedSWR<{
    results: [];
  }>("agents", scope);

  const { data: chatsData, isLoading: isLoadingChats } = useScopedSWR<{
    results: [];
    totalCount: number;
  }>(chatListEntity(), scope);

  const { data: providersData, isLoading: isLoadingProviders } = useScopedSWR<{
    results: [];
  }>("providers", scope);

  const { data: skillsData, isLoading: isLoadingSkills } = useScopedSWR<{
    results: [];
  }>("skills", scope);

  const { data: triggersData, isLoading: isLoadingTriggers } = useScopedSWR<{
    results: [];
  }>("triggers", scope);

  const { data: boardsData, isLoading: isLoadingBoards } = useScopedSWR<{
    results: [];
  }>("boards", scope);

  const { data: dashboardsData, isLoading: isLoadingDashboards } =
    useScopedSWR<{
      results: [];
    }>("dashboards", scope);

  const { data: orgData, isLoading: isLoadingOrg } = useScopedSWR<Organization>(
    organizationEntity(orgId),
    {},
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
    return <WorkspaceSkeleton />;
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
            href={routes.settings.root}
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
            {/* AgentsList renders the Create / Attach buttons and empty states */}
            <AgentsList orgId={orgId} workspaceId={workspaceId} />
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
            storageKey={SECTION_KEYS.skills}
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
            storageKey={SECTION_KEYS.dashboards}
          >
            <DashboardsList orgId={orgId} workspaceId={workspaceId} />
            <Button variant="outline" asChild>
              <Link href={routes.dashboards.create}>
                <Plus /> Create dashboard
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
            storageKey={SECTION_KEYS.boards}
          >
            <BoardsList orgId={orgId} workspaceId={workspaceId} />
            <Button variant="outline" asChild>
              <Link href={routes.boards.create}>
                <Plus /> Create board
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
            storageKey={SECTION_KEYS.triggers}
          >
            <TriggerList orgId={orgId} workspaceId={workspaceId} />
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" asChild>
                <Link href={routes.triggers.create}>
                  <Plus /> Create trigger
                </Link>
              </Button>
              <Button variant="outline" asChild>
                <Link href={routes.triggerRuns.root}>
                  <History /> Trigger runs
                </Link>
              </Button>
            </div>
          </CollapsibleSection>
        </>
      )}
    </div>
  );
};

export default Workspace;
