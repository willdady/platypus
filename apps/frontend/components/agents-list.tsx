"use client";

import { useState } from "react";
import {
  Item,
  ItemTitle,
  ItemActions,
  ItemDescription,
  ItemContent,
  ItemMedia,
} from "@/components/ui/item";
import { Button } from "@/components/ui/button";
import { OrganizationBadge } from "@/components/resource-list";
import { CloneDialog } from "@/components/clone-dialog";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { ListError } from "@/components/list-state";
import { EmptyCard } from "@/components/empty-card";
import {
  ButtonRowSkeleton,
  CardGridSkeleton,
  IconButtonSkeleton,
  LoadingRegion,
  SkeletonLine,
} from "@/components/list-skeletons";
import { Skeleton } from "@/components/ui/skeleton";
import { RowActionsMenu, type RowAction } from "@/components/row-actions-menu";
import { CountTooltip } from "@/components/count-tooltip";
import {
  ArrowUpFromLine,
  Bot,
  BotMessageSquare,
  Pin,
  PinOff,
  Plus,
  Wrench,
  Sparkles,
} from "lucide-react";
import {
  type Agent,
  type Provider,
  type ToolSet,
  type Skill,
} from "@platypus/schemas";
import { useScopedList } from "@/hooks/use-scoped-list";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth, useBackendUrl } from "@/components/auth-provider";
import {
  canCreateAgent,
  canManageSharedResource,
  canPinAgent,
} from "@/lib/authorization";
import { NoProvidersEmptyState } from "@/components/no-providers-empty-state";
import {
  AttachSharedAction,
  DetachSharedDialog,
  PromoteSharedDialog,
} from "@/components/shared-resource-actions";
import {
  scopedUrl,
  writeAt,
  writeEntity,
  type Scope,
  type Serialized,
} from "@/lib/api-write";
import { splitPinned } from "@/lib/pinned-agents";
import {
  ListFooter,
  ListPagination,
  GhostCards,
  pageOf,
} from "@/components/list-pagination";
import {
  usePromoteShared,
  useSharedDetach,
} from "@/hooks/use-shared-resource-actions";
import { useDeleteFlow } from "@/hooks/use-delete-flow";
import { useOptimisticRows } from "@/hooks/use-optimistic-rows";
import { orgRoutes, workspaceRoutes } from "@/lib/routes";

// The Agent is shown either in a Workspace, where it may be a workspace-scoped
// Agent or an attached org-scoped (Shared) Agent rendered with an Organization
// badge (ADR-0007). The backend tags each row with its scope.
type AgentWithScope = Serialized<Agent> & {
  scope?: "organization" | "workspace";
};

// The card's New chat + menu sit beside the content from `xl`, and wrap to a
// full-width row under it (indented past the avatar) below that.
const agentCardActionsClassName =
  "basis-full justify-between pl-16 xl:basis-auto xl:pl-0";

/** The agent cards as they load; the workspace home draws them too. */
export function AgentCardsSkeleton({ cards }: { cards?: number }) {
  return (
    <CardGridSkeleton
      cards={cards}
      media
      className="items-stretch"
      extra={
        // The tool set / skill / sub-agent counts.
        <div className="flex gap-3 mt-auto">
          {["w-16", "w-14", "w-20"].map((width) => (
            <SkeletonLine
              key={width}
              lineClassName="h-4"
              className={`h-3 ${width}`}
            />
          ))}
        </div>
      }
      actions={
        <ItemActions className={agentCardActionsClassName}>
          <Skeleton className="h-8 w-24" />
          <IconButtonSkeleton />
        </ItemActions>
      }
    />
  );
}

/** Unpinned agents per page; the Pinned group is always drawn in full. */
const AGENTS_PAGE_SIZE = 8;

export function AgentsList({
  orgId,
  workspaceId,
}: {
  orgId: string;
  workspaceId: string;
}) {
  const { actor, ownsWorkspace } = useAuth();
  const backendUrl = useBackendUrl();
  const router = useRouter();
  const [agentToClone, setAgentToClone] = useState<AgentWithScope | null>(null);
  const searchParams = useSearchParams();

  // Resolved once per render and reused for the list's reads and every write
  // below, rather than re-deriving the Organization-vs-Workspace branch at
  // each call site.
  const scope: Scope = { orgId, workspaceId };
  const routes = workspaceRoutes(orgId, workspaceId);

  const {
    results: allAgents,
    error: agentsError,
    isLoading: isLoadingAgents,
    mutate,
  } = useScopedList<AgentWithScope>("agents", scope);

  const { results: providers, isLoading: isLoadingProviders } =
    useScopedList<Provider>("providers", scope);

  const { results: toolSets } = useScopedList<ToolSet>("tools", scope);

  const { results: skills } = useScopedList<Skill>("skills", scope);

  const orgAgentDetach = useSharedDetach<AgentWithScope>({
    resourceType: "agent",
    scope,
    mutate,
  });

  const promote = usePromoteShared<AgentWithScope>({
    entity: "agents",
    scope,
    mutate,
  });

  // A pin shows at once and reverts if refused; each agent's Pin item is
  // disabled only while its own write runs.
  const pins = useOptimisticRows<AgentWithScope>();
  const togglePin = (agent: AgentWithScope) => {
    if (!backendUrl) return;
    void pins.run(
      agent.id,
      { isPinned: !agent.isPinned },
      () =>
        writeAt(scopedUrl(backendUrl, `agents/${agent.id}/pin`, scope), {
          method: agent.isPinned ? "DELETE" : "PUT",
        }),
      mutate,
    );
  };

  const agents = pins
    .apply(allAgents)
    .sort((a, b) => a.name.localeCompare(b.name));
  // A Pinned Agent shows only in the Pinned group, above the rest.
  const { pinned: pinnedAgents, unpinned: unpinnedAgents } =
    splitPinned(agents);
  const page = pageOf(
    searchParams.get("agentsPage"),
    unpinnedAgents,
    AGENTS_PAGE_SIZE,
  );

  // Attach, detach, and Promote a Shared resource are the same rule
  // (ADR-0007), asked of the auth module instead of re-derived here.
  const canManageShared = canManageSharedResource(actor, workspaceId);
  const canPin = canPinAgent(ownsWorkspace);
  const canClone = canCreateAgent(ownsWorkspace);

  const getToolSetNames = (toolSetIds: string[] | undefined) => {
    if (!toolSetIds?.length) return [];
    return toolSetIds
      .map((id) => toolSets.find((ts) => ts.id === id)?.name)
      .filter(Boolean) as string[];
  };

  const getSkillNames = (skillIds: string[] | undefined) => {
    if (!skillIds?.length) return [];
    return skillIds
      .map((id) => skills.find((s) => s.id === id)?.name)
      .filter(Boolean) as string[];
  };

  const getSubAgentNames = (subAgentIds: string[] | undefined) => {
    if (!subAgentIds?.length) return [];
    return subAgentIds
      .map((id) => agents.find((a) => a.id === id)?.name)
      .filter(Boolean) as string[];
  };

  const deleteFlow = useDeleteFlow<AgentWithScope>({
    mutate,
    guidanceOnForbidden: true,
    delete: (agent, url) => writeEntity(url, "agents", scope, { id: agent.id }),
  });

  const handleDeleteClick = (agent: Serialized<Agent>) => {
    deleteFlow.request(agent);
  };

  // A clone keeps only the references visible in this workspace: a Shared
  // Agent may point at Shared resources never attached here (ADR-0007),
  // which the create refuses (sub-agents) or keeps as dead references.
  const cloneReferences = (agent: AgentWithScope) => {
    const keep = (ids: string[] | undefined, visible: { id: string }[]) =>
      ids?.filter((id) => visible.some((resource) => resource.id === id));
    const kept = {
      subAgentIds: keep(agent.subAgentIds, agents),
      skillIds: keep(agent.skillIds, skills),
      toolSetIds: keep(agent.toolSetIds, toolSets),
    };
    const dropped = (
      [
        ["sub-agent", agent.subAgentIds, kept.subAgentIds],
        ["skill", agent.skillIds, kept.skillIds],
        ["tool set", agent.toolSetIds, kept.toolSetIds],
      ] as const
    )
      .map(([noun, ids, keptIds]) => {
        const count = (ids?.length ?? 0) - (keptIds?.length ?? 0);
        return count && `${count} ${noun}${count === 1 ? "" : "s"}`;
      })
      .filter(Boolean);
    return { kept, dropped };
  };

  const createClone = (
    agent: AgentWithScope,
    references: ReturnType<typeof cloneReferences>["kept"],
    cloneName: string,
    url: string,
  ) => {
    const {
      id,
      createdAt,
      updatedAt,
      avatarUrl,
      scope: agentScope,
      organizationId,
      ...cloneData
    } = agent;

    const sanitizedData = Object.fromEntries(
      Object.entries({
        ...cloneData,
        ...references,
        workspaceId,
        name: cloneName,
      }).map(([key, value]) => [key, value === null ? undefined : value]),
    );

    return writeEntity<Agent>(url, "agents", scope, { data: sanitizedData });
  };

  if (isLoadingAgents || isLoadingProviders) {
    return (
      <LoadingRegion label="Loading agents">
        <AgentCardsSkeleton />
        <ButtonRowSkeleton
          className="mt-4"
          widths={["w-36", ...(canManageShared ? ["w-44"] : [])]}
        />
      </LoadingRegion>
    );
  }

  if (agentsError) {
    return <ListError error={agentsError} subject="agents" />;
  }

  if (!providers.length) {
    return (
      <div className="flex items-center justify-center h-full p-8">
        <div className="w-full xl:w-4/5 max-w-4xl">
          <NoProvidersEmptyState orgId={orgId} workspaceId={workspaceId} />
        </div>
      </div>
    );
  }

  const renderMenu = (agent: AgentWithScope) => {
    const isOrgScoped = agent.scope === "organization";
    const pinAction: RowAction[] = canPin
      ? [
          {
            label: agent.isPinned ? "Unpin" : "Pin",
            icon: agent.isPinned ? <PinOff /> : <Pin />,
            onSelect: () => togglePin(agent),
            disabled: pins.isPending(agent.id),
          },
        ]
      : [];

    if (isOrgScoped) {
      // A Shared Agent is locked in the Workspace; only an Org Admin can
      // open it in the org settings editor or detach it here (ADR-0007). The
      // Owner can Clone it into a Workspace Agent of their own.
      return (
        <RowActionsMenu
          name={agent.name}
          shared
          edit={
            canManageShared
              ? { href: orgRoutes(orgId).settings.agentDetail(agent.id) }
              : undefined
          }
          actions={pinAction}
          clone={
            canClone ? { onSelect: () => setAgentToClone(agent) } : undefined
          }
          remove={
            canManageShared
              ? { onSelect: () => orgAgentDetach.open(agent) }
              : undefined
          }
        />
      );
    }

    return (
      <RowActionsMenu
        name={agent.name}
        edit={{ href: routes.agents.detail(agent.id) }}
        actions={[
          ...pinAction,
          ...(canManageShared
            ? [
                {
                  label: "Promote to organization",
                  icon: <ArrowUpFromLine />,
                  onSelect: () => promote.open(agent),
                },
              ]
            : []),
        ]}
        clone={{ onSelect: () => setAgentToClone(agent) }}
        remove={{ onSelect: () => handleDeleteClick(agent) }}
      />
    );
  };

  const renderCard = (agent: AgentWithScope) => {
    const isOrgScoped = agent.scope === "organization";
    // Count and list only references that actually resolve in this
    // workspace, so the badge count matches the tooltip — a detached
    // shared resource drops out of both (it is no longer active here).
    const toolSetNames = getToolSetNames(agent.toolSetIds);
    const skillNames = getSkillNames(agent.skillIds);
    const subAgentNames = getSubAgentNames(agent.subAgentIds);
    return (
      <li key={agent.id}>
        <Item variant="outline" className="h-full items-stretch">
          {agent.avatarUrl ? (
            <ItemMedia variant="image" className="size-12 rounded-full">
              {/* Agent avatar URL is user-supplied (arbitrary host); not
            routable through the Next image optimizer. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={agent.avatarUrl}
                alt={agent.name}
                className="size-full object-cover"
                width={48}
                height={48}
                loading="lazy"
                decoding="async"
              />
            </ItemMedia>
          ) : (
            <ItemMedia
              variant="icon"
              className="size-12 rounded-full [&_svg]:!size-7"
            >
              <Bot className="size-7 text-muted-foreground" />
            </ItemMedia>
          )}
          <ItemContent>
            <div className="flex min-h-badge items-center gap-2">
              <ItemTitle className="min-w-0">
                <span className="truncate" title={agent.name}>
                  {agent.name}
                </span>
              </ItemTitle>
              {isOrgScoped && <OrganizationBadge />}
            </div>
            {/* Always two lines tall, so every card is one height. */}
            <ItemDescription
              className="text-xs line-clamp-2 min-h-[2lh]"
              title={agent.description || undefined}
            >
              {agent.description}
            </ItemDescription>
            {/* One line: the counts clip rather than wrap. */}
            <div className="flex gap-3 mt-auto overflow-hidden text-xs text-muted-foreground">
              <CountTooltip
                icon={<Wrench className="size-3" />}
                noun="tool set"
                names={toolSetNames}
              />
              <CountTooltip
                icon={<Sparkles className="size-3" />}
                noun="skill"
                names={skillNames}
              />
              <CountTooltip
                icon={<Bot className="size-3" />}
                noun="sub-agent"
                names={subAgentNames}
              />
            </div>
          </ItemContent>
          <ItemActions className={agentCardActionsClassName}>
            <Button size="sm" asChild>
              <Link href={routes.chat.forAgent(agent.id)}>
                <BotMessageSquare /> New chat
              </Link>
            </Button>
            {renderMenu(agent)}
          </ItemActions>
        </Item>
      </li>
    );
  };

  const cloneRefs = agentToClone && cloneReferences(agentToClone);

  const gridClassName =
    "grid grid-cols-1 lg:grid-cols-2 auto-rows-fr gap-2 lg:gap-4";

  const actions = (
    <>
      <Button variant={agents.length ? "outline" : "default"} asChild>
        <Link href={routes.agents.create}>
          <Plus /> Create agent
        </Link>
      </Button>
      {canManageShared && (
        <AttachSharedAction
          orgId={orgId}
          workspaceId={workspaceId}
          resourceType="agent"
          label="Attach shared agent"
          resources={agents}
          onAttached={mutate}
        />
      )}
    </>
  );

  return (
    <>
      {agents.length === 0 ? (
        <EmptyCard
          icon={<Bot />}
          title="No agents yet"
          description="Create an agent to start chatting with it in this workspace."
          action={actions}
        />
      ) : (
        <>
          {pinnedAgents.length > 0 && (
            <div className="mb-2 flex flex-col gap-2">
              <h3 className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
                <Pin className="size-4" /> Pinned
              </h3>
              <ul aria-label="Pinned agents" className={gridClassName}>
                {pinnedAgents.map(renderCard)}
              </ul>
              <hr className="mt-4" />
            </div>
          )}
          {unpinnedAgents.length > 0 && (
            <ul aria-label="Agents" className={gridClassName}>
              {page.items.map(renderCard)}
              <GhostCards page={page} />
            </ul>
          )}
        </>
      )}

      {agents.length > 0 && (
        <ListFooter
          pagination={
            <ListPagination
              page={page}
              param="agentsPage"
              aria-label="Agents pages"
            />
          }
        >
          {actions}
        </ListFooter>
      )}

      <DetachSharedDialog
        detach={orgAgentDetach}
        title="Detach shared agent"
        description={(selected) => (
          <>
            Detach <strong>{selected.name}</strong> from this workspace? The
            shared agent itself is not deleted; it just stops appearing here.
          </>
        )}
        canDetach={canManageShared}
        orgSettingsHref={() => `/${orgId}/settings/agents`}
      />

      <PromoteSharedDialog promote={promote} noun="agent" />

      {cloneRefs && agentToClone && (
        <CloneDialog
          noun="Agent"
          original={agentToClone.name}
          onClose={() => setAgentToClone(null)}
          create={(name, url) =>
            createClone(agentToClone, cloneRefs.kept, name, url)
          }
          note={
            cloneRefs.dropped.length > 0 && (
              <p className="text-sm text-muted-foreground">
                Not included, as not attached to this workspace:{" "}
                {cloneRefs.dropped.join(", ")}.
              </p>
            )
          }
          onCreated={(id) => {
            void mutate();
            router.push(routes.agents.detail(id));
          }}
        />
      )}

      <DeleteConfirmDialog
        open={deleteFlow.open}
        onOpenChange={(open) => !open && deleteFlow.close()}
        title="Delete Agent"
        description={`Are you sure you want to delete "${deleteFlow.target?.name}"? This action cannot be undone.`}
        onConfirm={deleteFlow.confirm}
        loading={deleteFlow.deleting}
        error={deleteFlow.error}
      />
    </>
  );
}
