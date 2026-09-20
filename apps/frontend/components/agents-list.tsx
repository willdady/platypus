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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { ListError, ListState } from "@/components/list-state";
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
  Building,
  Copy,
  EllipsisVertical,
  Pencil,
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
import { useScopedSWR } from "@/hooks/use-scoped-swr";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth, useBackendUrl } from "@/components/auth-provider";
import { canManageSharedResource } from "@/lib/authorization";
import { NoProvidersEmptyState } from "@/components/no-providers-empty-state";
import {
  AttachSharedAction,
  DetachSharedDialog,
  PromoteSharedDialog,
} from "@/components/shared-resource-actions";
import { writeEntity, type Scope } from "@/lib/api-write";
import {
  usePromoteShared,
  useSharedDetach,
} from "@/hooks/use-shared-resource-actions";
import { useDeleteFlow } from "@/hooks/use-delete-flow";
import { orgRoutes, workspaceRoutes } from "@/lib/routes";

// The Agent is shown either in a Workspace, where it may be a workspace-scoped
// Agent or an attached org-scoped (Shared) Agent rendered with an Organization
// badge (ADR-0007). The backend tags each row with its scope.
type AgentWithScope = Agent & { scope?: "organization" | "workspace" };

export const AgentsList = ({
  orgId,
  workspaceId,
}: {
  orgId: string;
  workspaceId: string;
}) => {
  const { actor } = useAuth();
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
    data: agentsData,
    error: agentsError,
    isLoading: isLoadingAgents,
    mutate,
  } = useScopedSWR<{
    results: AgentWithScope[];
  }>("agents", scope);

  const { data: providersData, isLoading: isLoadingProviders } = useScopedSWR<{
    results: Provider[];
  }>("providers", scope);

  const { data: toolSetsData } = useScopedSWR<{
    results: ToolSet[];
  }>("tools", scope);

  const { data: skillsData } = useScopedSWR<{
    results: Skill[];
  }>("skills", scope);

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

  const agents = [...(agentsData?.results || [])].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  const providers = providersData?.results || [];
  const toolSets = toolSetsData?.results || [];
  const skills = skillsData?.results || [];

  // Attach, detach, and Promote a Shared resource are the same rule
  // (ADR-0007), asked of the auth module instead of re-derived here.
  const canManageShared = canManageSharedResource(actor, workspaceId).allowed;

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
    setCloneName(`${agent.name} (Copy)`);
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
    return <ListState variant="loading">Loading...</ListState>;
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

  const renderMenuItems = (agent: AgentWithScope) => {
    const isOrgScoped = agent.scope === "organization";
    return (
      <>
        {isOrgScoped ? (
          // A Shared Agent is locked in the Workspace; only an Org Admin can
          // open it in the org settings editor or detach it here (ADR-0007).
          canManageShared && (
            <>
              <DropdownMenuItem asChild>
                <Link
                  className="cursor-pointer"
                  href={orgRoutes(orgId).settings.agentDetail(agent.id)}
                >
                  <Pencil /> Edit in org settings
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem
                className="cursor-pointer"
                onSelect={() => orgAgentDetach.open(agent)}
              >
                <Unlink /> Detach
              </DropdownMenuItem>
            </>
          )
        ) : (
          <>
            <DropdownMenuItem asChild>
              <Link
                className="cursor-pointer"
                href={routes.agents.detail(agent.id)}
              >
                <Pencil /> Edit
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem
              className="cursor-pointer"
              onSelect={() => handleCloneClick(agent)}
            >
              <Copy /> Clone
            </DropdownMenuItem>
            {canManageShared && (
              <DropdownMenuItem
                className="cursor-pointer"
                onSelect={() => promote.open(agent)}
              >
                <ArrowUpFromLine /> Promote to organization
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="cursor-pointer text-destructive focus:text-destructive"
              onSelect={() => handleDeleteClick(agent)}
            >
              <Trash2 /> Delete
            </DropdownMenuItem>
          </>
        )}
      </>
    );
  };

  // A Shared Agent with no admin actions has an empty menu; hide the trigger.
  const hasMenu = (agent: AgentWithScope) =>
    agent.scope !== "organization" || canManageShared;

  return (
    <>
      {agents.length === 0 ? (
        <ListState variant="empty">
          No agents yet. Create one to get started.
        </ListState>
      ) : (
        <ul className="grid grid-cols-1 lg:grid-cols-2 grid-rows-1 gap-2 lg:gap-4">
          {agents.map((agent) => {
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
                    <ItemMedia variant="image" className="size-12 rounded-lg">
                      {/* Agent avatar URL is user-supplied (arbitrary host); not
                    routable through the Next image optimizer. */}
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={agent.avatarUrl}
                        alt={agent.name}
                        className="size-full object-cover"
                      />
                    </ItemMedia>
                  ) : (
                    <ItemMedia
                      variant="icon"
                      className="size-12 rounded-lg [&_svg]:!size-7"
                    >
                      <Bot className="h-7 w-7 text-muted-foreground" />
                    </ItemMedia>
                  )}
                  <ItemContent>
                    <div className="flex items-center gap-2">
                      <ItemTitle>{agent.name}</ItemTitle>
                      {isOrgScoped && (
                        <div className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-secondary text-[10px] font-medium text-secondary-foreground uppercase tracking-wider">
                          <Building className="size-3" />
                          Organization
                        </div>
                      )}
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
                            className="cursor-pointer text-muted-foreground"
                            variant="ghost"
                            size="icon"
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
                            className="cursor-pointer text-muted-foreground"
                            variant="ghost"
                            size="icon"
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
          })}
        </ul>
      )}

      <div className="mt-4 flex gap-2">
        <Button variant="outline" asChild>
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
      </div>

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
          <Input
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
          {cloneError && (
            <p className="text-destructive text-sm">{cloneError}</p>
          )}
          <DialogFooter>
            <Button
              className="cursor-pointer"
              variant="ghost"
              onClick={() => setCloneDialogOpen(false)}
            >
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
