"use client";

import { useState } from "react";
import {
  Item,
  ItemTitle,
  ItemActions,
  ItemDescription,
  ItemContent,
  ItemMedia,
  ItemFooter,
} from "@/components/ui/item";
import { Button } from "@/components/ui/button";
import { OrganizationBadge } from "@/components/resource-list";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Field, FieldLabel } from "@/components/ui/field";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  ArrowUpFromLine,
  Bot,
  BotMessageSquare,
  Copy,
  EllipsisVertical,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Trash2,
  Unlink,
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
import { useRouter } from "next/navigation";
import { useAuth, useBackendUrl } from "@/components/auth-provider";
import { canManageSharedResource, canPinAgent } from "@/lib/authorization";
import { NoProvidersEmptyState } from "@/components/no-providers-empty-state";
import {
  AttachSharedAction,
  DetachSharedDialog,
  PromoteSharedDialog,
} from "@/components/shared-resource-actions";
import { scopedUrl, writeAt, writeEntity, type Scope } from "@/lib/api-write";
import { splitPinned } from "@/lib/pinned-agents";
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
type AgentWithScope = Agent & { scope?: "organization" | "workspace" };

// The card's New chat + menu sit beside the content from `xl`, and in a footer
// row under it below that — the same split the loaded card makes.
const agentCardActions = (
  <>
    <Skeleton className="h-8 w-24" />
    <IconButtonSkeleton />
  </>
);

/** The agent cards as they load; the workspace home draws them too. */
export const AgentCardsSkeleton = ({ cards }: { cards?: number }) => (
  <CardGridSkeleton
    cards={cards}
    media
    className="items-stretch"
    descriptionLines={2}
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
      <ItemActions className="hidden xl:flex">{agentCardActions}</ItemActions>
    }
    footer={
      <ItemFooter className="xl:hidden mt-0 pl-16">
        {agentCardActions}
      </ItemFooter>
    }
  />
);

export const AgentsList = ({
  orgId,
  workspaceId,
}: {
  orgId: string;
  workspaceId: string;
}) => {
  const { actor, ownsWorkspace } = useAuth();
  const backendUrl = useBackendUrl();
  const router = useRouter();
  const [cloneDialogOpen, setCloneDialogOpen] = useState(false);
  const [agentToClone, setAgentToClone] = useState<Agent | null>(null);
  const [cloneName, setCloneName] = useState("");
  const [cloneError, setCloneError] = useState<string | null>(null);

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

  // Attach, detach, and Promote a Shared resource are the same rule
  // (ADR-0007), asked of the auth module instead of re-derived here.
  const canManageShared = canManageSharedResource(actor, workspaceId);
  const canPin = canPinAgent(ownsWorkspace);

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

  const handleCloneClick = (agent: Agent) => {
    setAgentToClone(agent);
    setCloneName(`${agent.name} (copy)`);
    setCloneError(null);
    setCloneDialogOpen(true);
  };

  const deleteFlow = useDeleteFlow<AgentWithScope>({
    mutate,
    guidanceOnForbidden: true,
    delete: (agent, url) => writeEntity(url, "agents", scope, { id: agent.id }),
  });

  const handleDeleteClick = (agent: Agent) => {
    deleteFlow.request(agent);
  };

  const handleCloneConfirm = async () => {
    if (!agentToClone || !backendUrl) return;

    setCloneError(null);

    const {
      id,
      createdAt,
      updatedAt,
      avatarUrl,
      scope: agentScope,
      organizationId,
      ...cloneData
    } = agentToClone as AgentWithScope;

    const sanitizedData = Object.fromEntries(
      Object.entries({
        ...cloneData,
        workspaceId,
        name: cloneName,
      }).map(([key, value]) => [key, value === null ? undefined : value]),
    );

    const outcome = await writeEntity<Agent>(backendUrl, "agents", scope, {
      data: sanitizedData,
    });

    if (outcome.outcome === "success") {
      mutate();
      setCloneDialogOpen(false);
      setAgentToClone(null);
      setCloneName("");
      router.push(routes.agents.detail(outcome.data.id));
    } else {
      setCloneError(outcome.message);
    }
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

  // The ⋮ order is the `card-conventions` skill's: Edit → item-specific →
  // Clone → separator → Delete; a Shared Agent's Detach takes Delete's place.
  const renderMenuItems = (agent: AgentWithScope) => {
    const isOrgScoped = agent.scope === "organization";
    const pinItem = canPin && (
      <DropdownMenuItem
        onSelect={() => togglePin(agent)}
        disabled={pins.isPending(agent.id)}
      >
        {agent.isPinned ? (
          <>
            <PinOff /> Unpin
          </>
        ) : (
          <>
            <Pin /> Pin
          </>
        )}
      </DropdownMenuItem>
    );

    if (isOrgScoped) {
      // A Shared Agent is locked in the Workspace; only an Org Admin can
      // open it in the org settings editor or detach it here (ADR-0007).
      return (
        <>
          {canManageShared && (
            <DropdownMenuItem asChild>
              <Link href={orgRoutes(orgId).settings.agentDetail(agent.id)}>
                <Pencil /> Edit in org settings
              </Link>
            </DropdownMenuItem>
          )}
          {pinItem}
          {canManageShared && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => orgAgentDetach.open(agent)}>
                <Unlink /> Detach
              </DropdownMenuItem>
            </>
          )}
        </>
      );
    }

    return (
      <>
        <DropdownMenuItem asChild>
          <Link href={routes.agents.detail(agent.id)}>
            <Pencil /> Edit
          </Link>
        </DropdownMenuItem>
        {pinItem}
        {canManageShared && (
          <DropdownMenuItem onSelect={() => promote.open(agent)}>
            <ArrowUpFromLine /> Promote to organization
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onSelect={() => handleCloneClick(agent)}>
          <Copy /> Clone
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="text-destructive focus:text-destructive"
          onSelect={() => handleDeleteClick(agent)}
        >
          <Trash2 /> Delete
        </DropdownMenuItem>
      </>
    );
  };

  // A Shared Agent with no admin actions has an empty menu; hide the trigger.
  const hasMenu = (agent: AgentWithScope) =>
    agent.scope !== "organization" || canManageShared || canPin;

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
              <Bot className="h-7 w-7 text-muted-foreground" />
            </ItemMedia>
          )}
          <ItemContent>
            <div className="flex items-center gap-2">
              <ItemTitle>{agent.name}</ItemTitle>
              {isOrgScoped && <OrganizationBadge />}
            </div>
            <ItemDescription className="text-xs line-clamp-3">
              {agent.description}
            </ItemDescription>
            <div className="flex gap-3 mt-auto text-xs text-muted-foreground">
              {toolSetNames.length ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="flex items-center gap-1 cursor-default">
                      <Wrench className="h-3 w-3" />
                      {toolSetNames.length} tool set
                      {toolSetNames.length !== 1 && "s"}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>
                    <ul className="text-left">
                      {toolSetNames.map((name) => (
                        <li key={name}>{name}</li>
                      ))}
                    </ul>
                  </TooltipContent>
                </Tooltip>
              ) : (
                <span className="flex items-center gap-1 cursor-default">
                  <Wrench className="h-3 w-3" />0 tool sets
                </span>
              )}
              {skillNames.length ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="flex items-center gap-1 cursor-default">
                      <Sparkles className="h-3 w-3" />
                      {skillNames.length} skill
                      {skillNames.length !== 1 && "s"}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>
                    <ul className="text-left">
                      {skillNames.map((name) => (
                        <li key={name}>{name}</li>
                      ))}
                    </ul>
                  </TooltipContent>
                </Tooltip>
              ) : (
                <span className="flex items-center gap-1 cursor-default">
                  <Sparkles className="h-3 w-3" />0 skills
                </span>
              )}
              {subAgentNames.length ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="flex items-center gap-1 cursor-default">
                      <Bot className="h-3 w-3" />
                      {subAgentNames.length} sub-agent
                      {subAgentNames.length !== 1 && "s"}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>
                    <ul className="text-left">
                      {subAgentNames.map((name) => (
                        <li key={name}>{name}</li>
                      ))}
                    </ul>
                  </TooltipContent>
                </Tooltip>
              ) : (
                <span className="flex items-center gap-1 cursor-default">
                  <Bot className="h-3 w-3" />0 sub-agents
                </span>
              )}
            </div>
          </ItemContent>
          <ItemActions className="hidden xl:flex">
            <Button size="sm" asChild>
              <Link href={routes.chat.forAgent(agent.id)}>
                <BotMessageSquare /> New chat
              </Link>
            </Button>
            {hasMenu(agent) && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    className="text-muted-foreground"
                    variant="ghost"
                    size="icon"
                    aria-label={`Actions for ${agent.name}`}
                  >
                    <EllipsisVertical className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  {renderMenuItems(agent)}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </ItemActions>
          <ItemFooter className="xl:hidden mt-0 pl-16">
            <Button size="sm" asChild>
              <Link href={routes.chat.forAgent(agent.id)}>
                <BotMessageSquare /> New chat
              </Link>
            </Button>
            {hasMenu(agent) && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    className="text-muted-foreground"
                    variant="ghost"
                    size="icon"
                    aria-label={`Actions for ${agent.name}`}
                  >
                    <EllipsisVertical className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  {renderMenuItems(agent)}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </ItemFooter>
        </Item>
      </li>
    );
  };

  const gridClassName =
    "grid grid-cols-1 lg:grid-cols-2 grid-rows-1 gap-2 lg:gap-4";

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
            <div className="mb-6 space-y-2">
              <h3 className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
                <Pin className="size-4" /> Pinned
              </h3>
              <ul aria-label="Pinned agents" className={gridClassName}>
                {pinnedAgents.map(renderCard)}
              </ul>
              <hr className="mt-6" />
            </div>
          )}
          {unpinnedAgents.length > 0 && (
            <ul aria-label="Agents" className={gridClassName}>
              {unpinnedAgents.map(renderCard)}
            </ul>
          )}
        </>
      )}

      {agents.length > 0 && <div className="mt-4 flex gap-2">{actions}</div>}

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

      <Dialog open={cloneDialogOpen} onOpenChange={setCloneDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Clone Agent</DialogTitle>
            <DialogDescription>
              Enter a name for the cloned agent.
            </DialogDescription>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor="clone-agent-name">Name</FieldLabel>
            <Input
              id="clone-agent-name"
              value={cloneName}
              onChange={(e) => {
                setCloneName(e.target.value);
                setCloneError(null);
              }}
              placeholder="Agent name"
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  handleCloneConfirm();
                }
              }}
            />
          </Field>
          {cloneError && (
            <p role="alert" className="text-destructive text-sm">
              {cloneError}
            </p>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCloneDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleCloneConfirm}>Clone</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
};
