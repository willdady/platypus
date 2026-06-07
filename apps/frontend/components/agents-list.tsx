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
import { ConfirmDialog } from "@/components/confirm-dialog";
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
  ExternalLink,
  Link2,
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
import useSWR from "swr";
import { fetcher, joinUrl } from "@/lib/utils";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useBackendUrl } from "@/app/client-context";
import { useAuth } from "@/components/auth-provider";
import { NoProvidersEmptyState } from "@/components/no-providers-empty-state";
import { AttachSharedResourceDialog } from "@/components/attach-shared-resource-dialog";

// The Agent is shown either in a Workspace, where it may be a workspace-scoped
// Agent or an attached org-scoped (Shared) Agent rendered with an Organization
// badge (ADR-0007). The backend tags each row with its scope.
type AgentWithScope = Agent & { scope?: "organization" | "workspace" };

type PromoteBlocker = {
  type: "provider" | "skill" | "subAgent" | "mcp";
  id: string;
  name: string;
};

const BLOCKER_LABEL: Record<PromoteBlocker["type"], string> = {
  provider: "Provider",
  skill: "Skill",
  subAgent: "Sub-agent",
  mcp: "MCP tool set",
};

export const AgentsList = ({
  orgId,
  workspaceId,
}: {
  orgId: string;
  workspaceId: string;
}) => {
  const { user, isOrgAdmin } = useAuth();
  const backendUrl = useBackendUrl();
  const router = useRouter();
  const [cloneDialogOpen, setCloneDialogOpen] = useState(false);
  const [agentToClone, setAgentToClone] = useState<Agent | null>(null);
  const [cloneName, setCloneName] = useState("");
  const [cloneError, setCloneError] = useState<string | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [agentToDelete, setAgentToDelete] = useState<Agent | null>(null);
  const [attachOpen, setAttachOpen] = useState(false);
  const [selectedOrgAgent, setSelectedOrgAgent] =
    useState<AgentWithScope | null>(null);
  const [detaching, setDetaching] = useState(false);
  const [agentToPromote, setAgentToPromote] = useState<AgentWithScope | null>(
    null,
  );
  const [promoting, setPromoting] = useState(false);
  const [promoteError, setPromoteError] = useState<string | null>(null);
  const [promoteBlockers, setPromoteBlockers] = useState<PromoteBlocker[]>([]);

  const {
    data: agentsData,
    isLoading: isLoadingAgents,
    mutate,
  } = useSWR<{
    results: AgentWithScope[];
  }>(
    backendUrl && user
      ? joinUrl(
          backendUrl,
          `/organizations/${orgId}/workspaces/${workspaceId}/agents`,
        )
      : null,
    fetcher,
  );

  const { data: providersData, isLoading: isLoadingProviders } = useSWR<{
    results: Provider[];
  }>(
    backendUrl && user
      ? joinUrl(
          backendUrl,
          `/organizations/${orgId}/workspaces/${workspaceId}/providers`,
        )
      : null,
    fetcher,
  );

  const { data: toolSetsData } = useSWR<{
    results: ToolSet[];
  }>(
    backendUrl && user
      ? joinUrl(
          backendUrl,
          `/organizations/${orgId}/workspaces/${workspaceId}/tools`,
        )
      : null,
    fetcher,
  );

  const { data: skillsData } = useSWR<{
    results: Skill[];
  }>(
    backendUrl && user
      ? joinUrl(
          backendUrl,
          `/organizations/${orgId}/workspaces/${workspaceId}/skills`,
        )
      : null,
    fetcher,
  );

  const agents = [...(agentsData?.results || [])].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  const providers = providersData?.results || [];
  const toolSets = toolSetsData?.results || [];
  const skills = skillsData?.results || [];

  // Promote and attach are Org Admin actions (ADR-0007).
  const canManageShared = isOrgAdmin;
  const attachedOrgIds = agents
    .filter((a) => a.scope === "organization")
    .map((a) => a.id);

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

  const handleDeleteClick = (agent: Agent) => {
    setAgentToDelete(agent);
    setDeleteDialogOpen(true);
  };

  const handleDeleteConfirm = async () => {
    if (!agentToDelete || !backendUrl) return;

    try {
      const response = await fetch(
        joinUrl(
          backendUrl,
          `/organizations/${orgId}/workspaces/${workspaceId}/agents/${agentToDelete.id}`,
        ),
        {
          method: "DELETE",
          credentials: "include",
        },
      );

      if (response.ok) {
        mutate();
        setDeleteDialogOpen(false);
        setAgentToDelete(null);
      }
    } catch (error) {
      console.error("Failed to delete agent:", error);
    }
  };

  const handleCloneConfirm = async () => {
    if (!agentToClone || !backendUrl) return;

    setCloneError(null);

    const {
      id,
      createdAt,
      updatedAt,
      avatarUrl,
      scope,
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

    try {
      const response = await fetch(
        joinUrl(
          backendUrl,
          `/organizations/${orgId}/workspaces/${workspaceId}/agents`,
        ),
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          credentials: "include",
          body: JSON.stringify(sanitizedData),
        },
      );

      if (response.ok) {
        const newAgent = await response.json();
        mutate();
        setCloneDialogOpen(false);
        setAgentToClone(null);
        setCloneName("");
        router.push(`/${orgId}/workspace/${workspaceId}/agents/${newAgent.id}`);
      } else {
        const errorData = await response.json();
        if (errorData.error && Array.isArray(errorData.error)) {
          setCloneError(errorData.error[0]?.message || "Failed to clone agent");
        } else {
          setCloneError("Failed to clone agent");
        }
      }
    } catch (error) {
      console.error("Failed to clone agent:", error);
      setCloneError("Failed to clone agent");
    }
  };

  const handlePromoteConfirm = async () => {
    if (!agentToPromote || !backendUrl) return;
    setPromoting(true);
    setPromoteError(null);
    setPromoteBlockers([]);
    try {
      const response = await fetch(
        joinUrl(
          backendUrl,
          `/organizations/${orgId}/workspaces/${workspaceId}/agents/${agentToPromote.id}/promote`,
        ),
        { method: "POST", credentials: "include" },
      );
      if (response.ok) {
        await mutate();
        setAgentToPromote(null);
      } else {
        const info = await response.json().catch(() => ({}));
        if (Array.isArray(info.blockers) && info.blockers.length > 0) {
          setPromoteBlockers(info.blockers);
        }
        setPromoteError(info.error || "Failed to promote agent.");
      }
    } finally {
      setPromoting(false);
    }
  };

  const detachOrgAgent = async (agentId: string) => {
    if (!backendUrl) return;
    setDetaching(true);
    try {
      await fetch(
        joinUrl(
          backendUrl,
          `/organizations/${orgId}/workspaces/${workspaceId}/attachments/agent/${agentId}`,
        ),
        { method: "DELETE", credentials: "include" },
      );
      setSelectedOrgAgent(null);
      await mutate();
    } finally {
      setDetaching(false);
    }
  };

  if (isLoadingAgents || isLoadingProviders) {
    return <div>Loading...</div>;
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
          isOrgAdmin && (
            <>
              <DropdownMenuItem asChild>
                <Link
                  className="cursor-pointer"
                  href={`/${orgId}/settings/agents/${agent.id}`}
                >
                  <Pencil /> Edit in org settings
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem
                className="cursor-pointer"
                onSelect={() => setSelectedOrgAgent(agent)}
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
                href={`/${orgId}/workspace/${workspaceId}/agents/${agent.id}`}
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
                onSelect={() => {
                  setPromoteError(null);
                  setPromoteBlockers([]);
                  setAgentToPromote(agent);
                }}
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
    agent.scope !== "organization" || isOrgAdmin;

  return (
    <>
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
                    <Link
                      href={`/${orgId}/workspace/${workspaceId}/chat?agentId=${agent.id}`}
                    >
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
                    <Link
                      href={`/${orgId}/workspace/${workspaceId}/chat?agentId=${agent.id}`}
                    >
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

      <div className="mt-4 flex gap-2">
        <Button variant="outline" asChild>
          <Link href={`/${orgId}/workspace/${workspaceId}/agents/create`}>
            <Plus /> Create agent
          </Link>
        </Button>
        {canManageShared && (
          <Button variant="outline" onClick={() => setAttachOpen(true)}>
            <Link2 className="size-4" /> Attach shared agent
          </Button>
        )}
      </div>

      {canManageShared && (
        <AttachSharedResourceDialog
          open={attachOpen}
          onOpenChange={setAttachOpen}
          orgId={orgId}
          workspaceId={workspaceId}
          resourceType="agent"
          attachedIds={attachedOrgIds}
          onAttached={() => {
            setAttachOpen(false);
            mutate();
          }}
        />
      )}

      <Dialog
        open={!!selectedOrgAgent}
        onOpenChange={(open) => !open && setSelectedOrgAgent(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Detach shared agent</DialogTitle>
            <DialogDescription>
              Detach <strong>{selectedOrgAgent?.name}</strong> from this
              workspace? The shared agent itself is not deleted; it just stops
              appearing here.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSelectedOrgAgent(null)}>
              Close
            </Button>
            {isOrgAdmin && selectedOrgAgent && (
              <Button asChild variant="ghost">
                <Link href={`/${orgId}/settings/agents`}>
                  <ExternalLink className="size-4" />
                  Org settings
                </Link>
              </Button>
            )}
            {selectedOrgAgent && (
              <Button
                variant="destructive"
                disabled={detaching}
                onClick={() => detachOrgAgent(selectedOrgAgent.id)}
              >
                <Unlink className="size-4" />
                Detach
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!agentToPromote}
        onOpenChange={(open) => {
          if (!open) {
            setAgentToPromote(null);
            setPromoteError(null);
            setPromoteBlockers([]);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Promote to organization</DialogTitle>
            <DialogDescription>
              Promote <strong>{agentToPromote?.name}</strong> to an
              organization-shared agent? It will be managed by org admins and
              remain attached to this workspace.
            </DialogDescription>
          </DialogHeader>
          {promoteBlockers.length > 0 && (
            <div className="rounded-md border border-warning bg-warning/10 p-3 text-sm">
              <p className="mb-2 font-medium">
                Promote the following workspace-private references first:
              </p>
              <ul className="space-y-1">
                {promoteBlockers.map((b) => (
                  <li key={`${b.type}-${b.id}`} className="flex gap-2">
                    <span className="text-muted-foreground">
                      {BLOCKER_LABEL[b.type]}:
                    </span>
                    <span className="font-medium">{b.name}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {promoteError && promoteBlockers.length === 0 && (
            <p className="text-sm text-destructive">{promoteError}</p>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setAgentToPromote(null);
                setPromoteError(null);
                setPromoteBlockers([]);
              }}
            >
              Cancel
            </Button>
            <Button onClick={handlePromoteConfirm} disabled={promoting}>
              Promote
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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

      <ConfirmDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        title="Delete Agent"
        description={`Are you sure you want to delete "${agentToDelete?.name}"? This action cannot be undone.`}
        confirmLabel="Delete"
        confirmVariant="destructive"
        onConfirm={handleDeleteConfirm}
      />
    </>
  );
};
