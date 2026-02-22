"use client";

import { useState } from "react";
import {
  Item,
  ItemTitle,
  ItemActions,
  ItemDescription,
  ItemContent,
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
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Bot,
  BotMessageSquare,
  Copy,
  EllipsisVertical,
  Pencil,
  Trash2,
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

export const AgentsList = ({
  orgId,
  workspaceId,
}: {
  orgId: string;
  workspaceId: string;
}) => {
  const { user } = useAuth();
  const backendUrl = useBackendUrl();
  const router = useRouter();
  const [cloneDialogOpen, setCloneDialogOpen] = useState(false);
  const [agentToClone, setAgentToClone] = useState<Agent | null>(null);
  const [cloneName, setCloneName] = useState("");
  const [cloneError, setCloneError] = useState<string | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [agentToDelete, setAgentToDelete] = useState<Agent | null>(null);

  const {
    data: agentsData,
    isLoading: isLoadingAgents,
    mutate,
  } = useSWR<{
    results: Agent[];
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

  const agents = agentsData?.results || [];
  const providers = providersData?.results || [];
  const toolSets = toolSetsData?.results || [];
  const skills = skillsData?.results || [];

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

    const { id, createdAt, updatedAt, ...cloneData } = agentToClone;

    const sanitizedData = Object.fromEntries(
      Object.entries({
        ...cloneData,
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

  if (isLoadingAgents || isLoadingProviders) {
    return <div>Loading...</div>;
  }

  if (!providers.length) {
    return (
      <div className="flex items-center justify-center h-[calc(100vh-2.75rem)] p-8">
        <div className="w-full xl:w-4/5 max-w-4xl">
          <NoProvidersEmptyState orgId={orgId} workspaceId={workspaceId} />
        </div>
      </div>
    );
  }

  if (!agents.length) {
    return null;
  }

  return (
    <>
      <ul className="grid grid-cols-1 lg:grid-cols-2 grid-rows-1 gap-4">
        {agents.map((agent) => (
          <li key={agent.id}>
            <Item variant="outline" className="h-full">
              <ItemContent>
                <ItemTitle>{agent.name}</ItemTitle>
                <ItemDescription className="text-xs">
                  {agent.description}
                </ItemDescription>
                <div className="flex gap-3 mt-1.5 text-xs text-muted-foreground">
                  {agent.toolSetIds?.length ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="flex items-center gap-1 cursor-default">
                          <Wrench className="h-3 w-3" />
                          {agent.toolSetIds.length} tool set
                          {agent.toolSetIds.length !== 1 && "s"}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>
                        <ul className="text-left">
                          {getToolSetNames(agent.toolSetIds).map((name) => (
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
                  {agent.skillIds?.length ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="flex items-center gap-1 cursor-default">
                          <Sparkles className="h-3 w-3" />
                          {agent.skillIds.length} skill
                          {agent.skillIds.length !== 1 && "s"}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>
                        <ul className="text-left">
                          {getSkillNames(agent.skillIds).map((name) => (
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
                  {agent.subAgentIds?.length ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="flex items-center gap-1 cursor-default">
                          <Bot className="h-3 w-3" />
                          {agent.subAgentIds.length} sub-agent
                          {agent.subAgentIds.length !== 1 && "s"}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>
                        <ul className="text-left">
                          {getSubAgentNames(agent.subAgentIds).map((name) => (
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
                    <DropdownMenuItem
                      className="cursor-pointer"
                      onSelect={() => handleCloneClick(agent)}
                    >
                      <Copy /> Clone
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      className="cursor-pointer"
                      onSelect={() => handleDeleteClick(agent)}
                    >
                      <Trash2 /> Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </ItemActions>
            </Item>
          </li>
        ))}
      </ul>

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
