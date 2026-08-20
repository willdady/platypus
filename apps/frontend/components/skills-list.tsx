"use client";

import { useState } from "react";
import { toast } from "sonner";
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
  Share2,
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
import { canManageSharedResource } from "@/lib/authorization";
import { AttachSharedResourceDialog } from "@/components/attach-shared-resource-dialog";
import {
  ManageAttachmentsDialog,
  SharedWithBadge,
} from "@/components/manage-sharing";
import { scopedPath, writeEntity, type Scope } from "@/lib/api-write";

// The list serves two surfaces: a Workspace (workspaceId provided) where it
// shows workspace-scoped Skills plus attached org-scoped Shared Skills as
// locked cards, and the Organization settings surface (no workspaceId) where it
// manages org-scoped Skills directly (ADR-0007).
type SkillWithScope = Skill & { scope?: "organization" | "workspace" };

// The agent-association indicator shown on workspace skill cards: a Bot icon
// with an "N agent(s)" count whose tooltip lists the agents, or a warning when
// the Skill is attached to no agents. Rendered for both workspace-scoped and
// attached org-scoped (Shared) Skills (#296). The trigger uses preventDefault
// (not stopPropagation) so the card's own click — navigation or opening the
// manage dialog — still fires.
const SkillAgentsIndicator = ({ agents }: { agents: Agent[] }) => (
  <div className="mt-1 text-xs text-muted-foreground">
    {agents.length > 0 ? (
      <Tooltip>
        <TooltipTrigger
          className="flex items-center gap-1 cursor-default"
          onClick={(e) => e.preventDefault()}
        >
          <Bot className="h-3 w-3" />
          {agents.length} agent{agents.length !== 1 && "s"}
        </TooltipTrigger>
        <TooltipContent>
          <ul className="text-left">
            {agents.map((agent) => (
              <li key={agent.id}>{agent.name}</li>
            ))}
          </ul>
        </TooltipContent>
      </Tooltip>
    ) : (
      <span className="flex items-center gap-1 cursor-default text-warning-foreground">
        <TriangleAlert className="h-3 w-3" />
        <strong>WARNING:</strong> Skill not associated with any agents.
      </span>
    )}
  </div>
);

export const SkillsList = ({
  orgId,
  workspaceId,
}: {
  orgId: string;
  workspaceId?: string;
}) => {
  const { user, isOrgAdmin, actor } = useAuth();
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
  const [detachError, setDetachError] = useState<string | null>(null);
  const [attachOpen, setAttachOpen] = useState(false);
  const [skillToPromote, setSkillToPromote] = useState<SkillWithScope | null>(
    null,
  );
  const [promoting, setPromoting] = useState(false);
  const [promoteError, setPromoteError] = useState<string | null>(null);
  const [skillToManage, setSkillToManage] = useState<SkillWithScope | null>(
    null,
  );
  const [deleteBlocked, setDeleteBlocked] = useState<{
    skill: SkillWithScope;
    count: number;
  } | null>(null);

  // Resolved once per render and reused for the list's read and every write
  // below, rather than re-deriving the Organization-vs-Workspace branch at
  // each call site.
  const scope: Scope = workspaceId ? { orgId, workspaceId } : { orgId };
  const listUrl = scopedPath("skills", scope);
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
      ? joinUrl(backendUrl, scopedPath("agents", scope))
      : null,
    fetcher,
  );

  const agents = agentsData?.results || [];

  const skills = [...(skillsData?.results || [])].sort((a, b) =>
    a.name.localeCompare(b.name),
  );

  // Attach, detach, and Promote a Shared resource are the same rule
  // (ADR-0007 / #154), asked of the auth module instead of re-derived here.
  const canAttach = canManageSharedResource(actor, workspaceId).allowed;
  const canPromote = canAttach;

  const attachedOrgIds = skills
    .filter((s) => s.scope === "organization")
    .map((s) => s.id);

  const getAgentsForSkill = (skillId: string) =>
    agents.filter((agent) => agent.skillIds?.includes(skillId));

  const handleDeleteClick = async (skill: SkillWithScope) => {
    setDeleteError(null);
    // On the Organization surface a Shared Skill can't be deleted while attached
    // (ADR-0007) — check the live count first and explain the blocker up front
    // instead of offering a Delete button that is guaranteed to fail.
    if (!workspaceId && backendUrl) {
      try {
        const res = await fetch(
          joinUrl(
            backendUrl,
            `${scopedPath("attachments", scope)}?resourceType=skill&resourceId=${skill.id}`,
          ),
          { credentials: "include" },
        );
        const info = await res.json().catch(() => ({ results: [] }));
        const count = (info.results ?? []).length;
        if (count > 0) {
          setDeleteBlocked({ skill, count });
          return;
        }
      } catch {
        // If the check fails, fall through — the backend still guards with 409.
      }
    }
    setSkillToDelete(skill);
    setDeleteDialogOpen(true);
  };

  const handleDeleteConfirm = async () => {
    if (!skillToDelete || !backendUrl) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      const outcome = await writeEntity(backendUrl, "skills", scope, {
        id: skillToDelete.id,
      });
      if (outcome.outcome === "success") {
        await mutate();
        setDeleteDialogOpen(false);
        setSkillToDelete(null);
      } else if (outcome.outcome === "locked") {
        // Guidance, not a failure — the backend's message already says
        // where the Shared resource is actually managed (#570).
        setDeleteDialogOpen(false);
        setSkillToDelete(null);
        toast.info(outcome.message);
      } else {
        setDeleteError(outcome.message);
      }
    } finally {
      setDeleting(false);
    }
  };

  const detachOrgSkill = async (skillId: string) => {
    if (!backendUrl || !workspaceId) return;
    setDetaching(true);
    setDetachError(null);
    try {
      const outcome = await writeEntity(
        backendUrl,
        "attachments/skill",
        scope,
        {
          id: skillId,
        },
      );
      if (outcome.outcome === "success") {
        setSelectedOrgSkill(null);
        await mutate();
      } else {
        setDetachError(outcome.message);
      }
    } finally {
      setDetaching(false);
    }
  };

  const handlePromoteConfirm = async () => {
    if (!skillToPromote || !backendUrl || !workspaceId) return;
    setPromoting(true);
    setPromoteError(null);
    try {
      const outcome = await writeEntity(
        backendUrl,
        `skills/${skillToPromote.id}/promote`,
        scope,
      );
      if (outcome.outcome === "success") {
        await mutate();
        setSkillToPromote(null);
      } else {
        setPromoteError(outcome.message);
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

          const skillAgents = getAgentsForSkill(skill.id);
          const agentCount = skillAgents.length;

          if (isOrgScopedInWorkspace) {
            return (
              <li key={skill.id}>
                <Item
                  variant="outline"
                  className="h-full cursor-pointer"
                  onClick={() => {
                    setDetachError(null);
                    setSelectedOrgSkill(skill);
                  }}
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
                    <SkillAgentsIndicator agents={skillAgents} />
                  </ItemContent>
                  <ItemActions>
                    <Pencil className="size-4" />
                  </ItemActions>
                </Item>
              </li>
            );
          }

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
                      <SkillAgentsIndicator agents={skillAgents} />
                    )}
                    {!workspaceId && isOrgAdmin && (
                      <div className="mt-1">
                        <SharedWithBadge
                          orgId={orgId}
                          resourceType="skill"
                          resourceId={skill.id}
                        />
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
                        {!workspaceId && isOrgAdmin && (
                          <DropdownMenuItem
                            className="cursor-pointer"
                            onSelect={() => setSkillToManage(skill)}
                          >
                            <Share2 /> Manage attachments
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
            <Plus /> Create skill
          </Link>
        </Button>
        {canAttach && (
          <Button variant="outline" onClick={() => setAttachOpen(true)}>
            <Link2 className="size-4" /> Attach shared skill
          </Button>
        )}
      </div>

      {skillToManage && (
        <ManageAttachmentsDialog
          orgId={orgId}
          resourceType="skill"
          resourceId={skillToManage.id}
          resourceName={skillToManage.name}
          open={!!skillToManage}
          onOpenChange={(open) => !open && setSkillToManage(null)}
        />
      )}

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
        onOpenChange={(open) => {
          if (!open) {
            setSelectedOrgSkill(null);
            setDetachError(null);
          }
        }}
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
          {detachError && (
            <p className="text-sm text-destructive">{detachError}</p>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setSelectedOrgSkill(null);
                setDetachError(null);
              }}
            >
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

      <ConfirmDialog
        open={!!deleteBlocked}
        onOpenChange={(open) => !open && setDeleteBlocked(null)}
        title="Can't delete shared skill"
        description={
          deleteBlocked
            ? `“${deleteBlocked.skill.name}” is shared with ${deleteBlocked.count} workspace${
                deleteBlocked.count !== 1 ? "s" : ""
              }. Detach it from every workspace before deleting.`
            : ""
        }
        confirmLabel="Manage attachments"
        cancelLabel="Close"
        onConfirm={() => {
          const skill = deleteBlocked?.skill ?? null;
          setDeleteBlocked(null);
          setSkillToManage(skill);
        }}
      />
    </>
  );
};
