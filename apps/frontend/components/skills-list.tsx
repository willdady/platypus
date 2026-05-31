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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
  Building,
  EllipsisVertical,
  ExternalLink,
  Link2,
  Pencil,
  Plus,
  Trash2,
  TriangleAlert,
  Unlink,
} from "lucide-react";
import { type Skill, type Agent } from "@platypus/schemas";
import useSWR from "swr";
import { fetcher, joinUrl } from "@/lib/utils";
import Link from "next/link";
import { useBackendUrl } from "@/app/client-context";
import { useAuth } from "@/components/auth-provider";
import { AttachSharedResourceDialog } from "@/components/attach-shared-resource-dialog";

// The list serves two surfaces: a Workspace (workspaceId provided) where it
// shows workspace-scoped Skills plus attached org-scoped Shared Skills as
// locked cards, and the Organization settings surface (no workspaceId) where it
// manages org-scoped Skills directly (ADR-0007).
type SkillWithScope = Skill & { scope?: "organization" | "workspace" };

export const SkillsList = ({
  orgId,
  workspaceId,
}: {
  orgId: string;
  workspaceId?: string;
}) => {
  const { user, isOrgAdmin } = useAuth();
  const backendUrl = useBackendUrl();
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [skillToDelete, setSkillToDelete] = useState<SkillWithScope | null>(
    null,
  );
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [selectedOrgSkill, setSelectedOrgSkill] =
    useState<SkillWithScope | null>(null);
  const [detaching, setDetaching] = useState(false);
  const [attachOpen, setAttachOpen] = useState(false);
  const [skillToPromote, setSkillToPromote] = useState<SkillWithScope | null>(
    null,
  );
  const [promoting, setPromoting] = useState(false);
  const [promoteError, setPromoteError] = useState<string | null>(null);

  const listUrl = workspaceId
    ? `/organizations/${orgId}/workspaces/${workspaceId}/skills`
    : `/organizations/${orgId}/skills`;
  const editBasePath = workspaceId
    ? `/${orgId}/workspace/${workspaceId}/skills`
    : `/${orgId}/settings/skills`;

  const {
    data: skillsData,
    isLoading,
    mutate,
  } = useSWR<{
    results: SkillWithScope[];
  }>(backendUrl && user ? joinUrl(backendUrl, listUrl) : null, fetcher);

  // Agent associations are a workspace concern; only fetched on that surface.
  const { data: agentsData } = useSWR<{
    results: Agent[];
  }>(
    backendUrl && user && workspaceId
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

  // Attaching/detaching org-scoped Shared resources is an Org Admin action,
  // available only inside a workspace (ADR-0007 / #154).
  const canAttach = Boolean(workspaceId) && isOrgAdmin;
  // Promote is an Org Admin action on a workspace-scoped Skill (ADR-0007).
  const canPromote = canAttach;

  const attachedOrgIds = skills
    .filter((s) => s.scope === "organization")
    .map((s) => s.id);

  const getAgentsForSkill = (skillId: string) =>
    agents.filter((agent) => agent.skillIds?.includes(skillId));

  const handleDeleteClick = (skill: SkillWithScope) => {
    setSkillToDelete(skill);
    setDeleteError(null);
    setDeleteDialogOpen(true);
  };

  const handleDeleteConfirm = async () => {
    if (!skillToDelete || !backendUrl) return;
    // Org-scoped Skills are deleted from the Organization surface; workspace
    // Skills from the workspace route.
    const deleteUrl =
      skillToDelete.scope === "organization" && !workspaceId
        ? `/organizations/${orgId}/skills/${skillToDelete.id}`
        : `${listUrl}/${skillToDelete.id}`;
    setDeleting(true);
    setDeleteError(null);
    try {
      const response = await fetch(joinUrl(backendUrl, deleteUrl), {
        method: "DELETE",
        credentials: "include",
      });
      if (response.ok) {
        await mutate();
        setDeleteDialogOpen(false);
        setSkillToDelete(null);
      } else {
        const info = await response.json().catch(() => ({}));
        setDeleteError(info.error || "Failed to delete skill.");
      }
    } finally {
      setDeleting(false);
    }
  };

  const detachOrgSkill = async (skillId: string) => {
    if (!backendUrl || !workspaceId) return;
    setDetaching(true);
    try {
      await fetch(
        joinUrl(
          backendUrl,
          `/organizations/${orgId}/workspaces/${workspaceId}/attachments/skill/${skillId}`,
        ),
        { method: "DELETE", credentials: "include" },
      );
      setSelectedOrgSkill(null);
      await mutate();
    } finally {
      setDetaching(false);
    }
  };

  const handlePromoteConfirm = async () => {
    if (!skillToPromote || !backendUrl || !workspaceId) return;
    setPromoting(true);
    setPromoteError(null);
    try {
      const response = await fetch(
        joinUrl(
          backendUrl,
          `/organizations/${orgId}/workspaces/${workspaceId}/skills/${skillToPromote.id}/promote`,
        ),
        { method: "POST", credentials: "include" },
      );
      if (response.ok) {
        await mutate();
        setSkillToPromote(null);
      } else {
        const info = await response.json().catch(() => ({}));
        setPromoteError(info.error || "Failed to promote skill.");
      }
    } finally {
      setPromoting(false);
    }
  };

  if (isLoading) {
    return <div>Loading...</div>;
  }

  return (
    <>
      <ul className="grid grid-cols-1 lg:grid-cols-2 grid-rows-1 gap-2 lg:gap-4">
        {skills.map((skill) => {
          // Org-scoped (Shared) Skills are locked inside a workspace: they can
          // only be edited from the organization settings surface.
          const isOrgScopedInWorkspace =
            Boolean(workspaceId) && skill.scope === "organization";

          if (isOrgScopedInWorkspace) {
            return (
              <li key={skill.id}>
                <Item
                  variant="outline"
                  className="h-full cursor-pointer"
                  onClick={() => setSelectedOrgSkill(skill)}
                >
                  <ItemContent>
                    <div className="flex items-center gap-2">
                      <ItemTitle>{skill.name}</ItemTitle>
                      <div className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-secondary text-[10px] font-medium text-secondary-foreground uppercase tracking-wider">
                        <Building className="size-3" />
                        Organization
                      </div>
                    </div>
                    <ItemDescription className="text-xs line-clamp-2">
                      {skill.description}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <Pencil className="size-4" />
                  </ItemActions>
                </Item>
              </li>
            );
          }

          const skillAgents = getAgentsForSkill(skill.id);
          const agentCount = skillAgents.length;

          return (
            <li key={skill.id}>
              <Item
                variant="outline"
                className={`h-full cursor-pointer ${
                  workspaceId && agentCount === 0 ? "border-warning" : ""
                }`}
                asChild
              >
                <Link href={`${editBasePath}/${skill.id}`}>
                  <ItemContent>
                    <ItemTitle>{skill.name}</ItemTitle>
                    <ItemDescription className="text-xs line-clamp-2">
                      {skill.description}
                    </ItemDescription>
                    {workspaceId && (
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
                    )}
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
                      <DropdownMenuContent onClick={(e) => e.preventDefault()}>
                        <DropdownMenuItem asChild>
                          <Link
                            className="cursor-pointer"
                            href={`${editBasePath}/${skill.id}`}
                          >
                            <Pencil /> Edit
                          </Link>
                        </DropdownMenuItem>
                        {canPromote && (
                          <DropdownMenuItem
                            className="cursor-pointer"
                            onSelect={() => {
                              setPromoteError(null);
                              setSkillToPromote(skill);
                            }}
                          >
                            <ArrowUpFromLine /> Promote to organization
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          className="cursor-pointer text-destructive focus:text-destructive"
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

      <div className="mt-4 flex gap-2">
        <Button variant="outline" asChild>
          <Link href={`${editBasePath}/create`}>
            <Plus /> Create Skill
          </Link>
        </Button>
        {canAttach && (
          <Button variant="outline" onClick={() => setAttachOpen(true)}>
            <Link2 className="size-4" /> Attach shared skill
          </Button>
        )}
      </div>

      {canAttach && workspaceId && (
        <AttachSharedResourceDialog
          open={attachOpen}
          onOpenChange={setAttachOpen}
          orgId={orgId}
          workspaceId={workspaceId}
          resourceType="skill"
          attachedIds={attachedOrgIds}
          onAttached={() => {
            setAttachOpen(false);
            mutate();
          }}
        />
      )}

      <Dialog
        open={!!selectedOrgSkill}
        onOpenChange={(open) => !open && setSelectedOrgSkill(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Organization Skill</DialogTitle>
            <DialogDescription>
              The skill <strong>{selectedOrgSkill?.name}</strong> is managed at
              the organization level. It can only be edited from the
              organization settings.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSelectedOrgSkill(null)}>
              Close
            </Button>
            {canAttach && selectedOrgSkill && (
              <Button
                variant="destructive"
                disabled={detaching}
                onClick={() => detachOrgSkill(selectedOrgSkill.id)}
              >
                <Unlink className="size-4" />
                Detach
              </Button>
            )}
            {isOrgAdmin && selectedOrgSkill && (
              <Button asChild>
                <Link href={`/${orgId}/settings/skills/${selectedOrgSkill.id}`}>
                  <ExternalLink className="size-4" />
                  Org settings
                </Link>
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!skillToPromote}
        onOpenChange={(open) => {
          if (!open) {
            setSkillToPromote(null);
            setPromoteError(null);
          }
        }}
        title="Promote to organization"
        description={`Promote "${skillToPromote?.name}" to an organization-shared skill? It will be managed by org admins and remain attached to this workspace.`}
        confirmLabel="Promote"
        onConfirm={handlePromoteConfirm}
        loading={promoting}
        error={promoteError}
      />

      <ConfirmDialog
        open={deleteDialogOpen}
        onOpenChange={(open) => {
          setDeleteDialogOpen(open);
          if (!open) {
            setSkillToDelete(null);
            setDeleteError(null);
          }
        }}
        title="Delete Skill"
        description={`Are you sure you want to delete "${skillToDelete?.name}"? This action cannot be undone.`}
        confirmLabel="Delete"
        confirmVariant="destructive"
        onConfirm={handleDeleteConfirm}
        loading={deleting}
        error={deleteError}
      />
    </>
  );
};
