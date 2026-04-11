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
import { Bot, EllipsisVertical, Trash2, TriangleAlert } from "lucide-react";
import { type Skill, type Agent } from "@platypus/schemas";
import useSWR from "swr";
import { fetcher, joinUrl } from "@/lib/utils";
import Link from "next/link";
import { useBackendUrl } from "@/app/client-context";
import { useAuth } from "@/components/auth-provider";

export const SkillsList = ({
  orgId,
  workspaceId,
}: {
  orgId: string;
  workspaceId: string;
}) => {
  const { user } = useAuth();
  const backendUrl = useBackendUrl();
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [skillToDelete, setSkillToDelete] = useState<Skill | null>(null);

  const {
    data: skillsData,
    isLoading,
    mutate,
  } = useSWR<{
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

  const { data: agentsData } = useSWR<{
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

  const agents = agentsData?.results || [];

  const skills = [...(skillsData?.results || [])].sort((a, b) =>
    a.name.localeCompare(b.name),
  );

  const getAgentsForSkill = (skillId: string) =>
    agents.filter((agent) => agent.skillIds?.includes(skillId));

  const handleDeleteClick = (skill: Skill) => {
    setSkillToDelete(skill);
    setDeleteDialogOpen(true);
  };

  const handleDeleteConfirm = async () => {
    if (!skillToDelete || !backendUrl) return;

    try {
      const response = await fetch(
        joinUrl(
          backendUrl,
          `/organizations/${orgId}/workspaces/${workspaceId}/skills/${skillToDelete.id}`,
        ),
        {
          method: "DELETE",
          credentials: "include",
        },
      );

      if (response.ok) {
        mutate();
        setDeleteDialogOpen(false);
        setSkillToDelete(null);
      }
    } catch (error) {
      console.error("Failed to delete skill:", error);
    }
  };

  if (isLoading) {
    return <div>Loading...</div>;
  }

  if (!skills.length) {
    return null;
  }

  return (
    <>
      <ul className="grid grid-cols-1 lg:grid-cols-2 grid-rows-1 gap-4">
        {skills.map((skill) => {
          const skillAgents = getAgentsForSkill(skill.id);
          const agentCount = skillAgents.length;

          return (
            <li key={skill.id}>
              <Item
                variant="outline"
                className={`h-full cursor-pointer ${agentCount === 0 ? "border-warning" : ""}`}
                asChild
              >
                <Link
                  href={`/${orgId}/workspace/${workspaceId}/skills/${skill.id}`}
                >
                  <ItemContent>
                    <ItemTitle>{skill.name}</ItemTitle>
                    <ItemDescription className="text-xs line-clamp-2">
                      {skill.description}
                    </ItemDescription>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {agentCount > 0 ? (
                        <Tooltip>
                          <TooltipTrigger
                            className="flex items-center gap-1 cursor-default"
                            onClick={(e) => e.preventDefault()}
                          >
                            <Bot className="h-3 w-3" />
                            {agentCount} agent{agentCount !== 1 && "s"}
                          </TooltipTrigger>
                          <TooltipContent>
                            <ul className="text-left">
                              {skillAgents.map((agent) => (
                                <li key={agent.id}>{agent.name}</li>
                              ))}
                            </ul>
                          </TooltipContent>
                        </Tooltip>
                      ) : (
                        <span className="flex items-center gap-1 cursor-default text-warning-foreground">
                          <TriangleAlert className="h-3 w-3" />
                          <strong>WARNING:</strong> Skill not associated with
                          any agents.
                        </span>
                      )}
                    </div>
                  </ItemContent>
                  <ItemActions>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          className="cursor-pointer text-muted-foreground"
                          variant="ghost"
                          size="icon"
                          onClick={(e) => e.preventDefault()}
                        >
                          <EllipsisVertical className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent
                        onClick={(e) => e.preventDefault()}
                      >
                        <DropdownMenuItem
                          className="cursor-pointer"
                          onSelect={() => handleDeleteClick(skill)}
                        >
                          <Trash2 /> Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </ItemActions>
                </Link>
              </Item>
            </li>
          );
        })}
      </ul>

      <ConfirmDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        title="Delete Skill"
        description={`Are you sure you want to delete "${skillToDelete?.name}"? This action cannot be undone.`}
        confirmLabel="Delete"
        confirmVariant="destructive"
        onConfirm={handleDeleteConfirm}
      />
    </>
  );
};
