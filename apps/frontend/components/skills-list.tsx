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
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { ListError, ListState } from "@/components/list-state";
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
  UserRound,
} from "lucide-react";
import { type Skill, type Agent } from "@platypus/schemas";
import { useScopedSWR } from "@/hooks/use-scoped-swr";
import Link from "next/link";
import { useAuth, useBackendUrl } from "@/components/auth-provider";
import {
  canManageOrgSharedResource,
  canManageSharedResource,
} from "@/lib/authorization";
import { AttachSharedResourceDialog } from "@/components/attach-shared-resource-dialog";
import {
  ManageAttachmentsDialog,
  SharedWithBadge,
} from "@/components/manage-sharing";
import {
  attachmentsEntity,
  scopedUrl,
  writeEntity,
  type Scope,
} from "@/lib/api-write";
import { useDetachDialog } from "@/hooks/use-detach-dialog";
import { useDeleteFlow } from "@/hooks/use-delete-flow";

// The list serves two surfaces: a Workspace (workspaceId provided) where it
// shows workspace-scoped Skills plus attached org-scoped Shared Skills as
// locked cards, and the Organization settings surface (no workspaceId) where it
// manages org-scoped Skills directly (ADR-0007).
type SkillWithScope = Skill & { scope?: "organization" | "workspace" };

const UserInvocableBadge = ({ skill }: { skill: SkillWithScope }) => {
  if (!skill.disableModelInvocation) return null;

  return (
    <span
      className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-secondary text-[10px] font-medium text-secondary-foreground uppercase tracking-wider"
      title="This skill is only invoked when a user triggers it"
    >
      <UserRound className="size-3" />
      User-invocable only
    </span>
  );
};

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
  const { actor } = useAuth();
  const backendUrl = useBackendUrl();
  const orgSkillDetach = useDetachDialog<SkillWithScope>();
  const [detaching, setDetaching] = useState(false);
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
  const editBasePath = workspaceId
    ? `/${orgId}/workspace/${workspaceId}/skills`
    : `/${orgId}/settings/skills`;

  const {
    data: skillsData,
    error,
    isLoading,
    mutate,
  } = useScopedSWR<{
    results: SkillWithScope[];
  }>("skills", scope);

  // Agent associations are a workspace concern; only fetched on that surface.
  const { data: agentsData } = useScopedSWR<{
    results: Agent[];
  }>("agents", workspaceId ? scope : null);

  const agents = agentsData?.results || [];

  const skills = [...(skillsData?.results || [])].sort((a, b) =>
    a.name.localeCompare(b.name),
  );

  // Attach, detach, and Promote a Shared resource are the same rule
  // (ADR-0007 / #154), asked of the auth module instead of re-derived here.
  const canAttach = canManageSharedResource(actor, workspaceId).allowed;
  const canPromote = canAttach;
  const canManageOrg = canManageOrgSharedResource(actor).allowed;

  const attachedOrgIds = skills
    .filter((s) => s.scope === "organization")
    .map((s) => s.id);

  const getAgentsForSkill = (skillId: string) =>
    agents.filter((agent) => agent.skillIds?.includes(skillId));

  const deleteFlow = useDeleteFlow<SkillWithScope>({
    mutate,
    guidanceOnForbidden: true,
    delete: (skill, url) => writeEntity(url, "skills", scope, { id: skill.id }),
  });

  const handleDeleteClick = async (skill: SkillWithScope) => {
    // On the Organization surface a Shared Skill can't be deleted while attached
    // (ADR-0007) — check the live count first and explain the blocker up front
    // instead of offering a Delete button that is guaranteed to fail.
    if (!workspaceId && backendUrl) {
      try {
        const res = await fetch(
          scopedUrl(backendUrl, attachmentsEntity("skill", skill.id), scope),
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
    deleteFlow.request(skill);
  };

  const detachOrgSkill = async (skillId: string) => {
    if (!backendUrl || !workspaceId) return;
    setDetaching(true);
    orgSkillDetach.setError(null);
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
        orgSkillDetach.close();
        await mutate();
      } else {
        orgSkillDetach.setError(outcome.message);
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
    return <ListState variant="loading">Loading...</ListState>;
  }

  if (error) {
    return <ListError error={error} subject="skills" />;
  }

  return (
    <>
      {skills.length === 0 ? (
        <ListState variant="empty">
          No skills yet. Create one to get started.
        </ListState>
      ) : (
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
                    onClick={() => orgSkillDetach.open(skill)}
                  >
                    <ItemContent>
                      <div className="flex items-center gap-2">
                        <ItemTitle>{skill.name}</ItemTitle>
                        <UserInvocableBadge skill={skill} />
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
                      <div className="flex items-center gap-2">
                        <ItemTitle>{skill.name}</ItemTitle>
                        <UserInvocableBadge skill={skill} />
                      </div>
                      <ItemDescription className="text-xs line-clamp-2">
                        {skill.description}
                      </ItemDescription>
                      {workspaceId && (
                        <SkillAgentsIndicator agents={skillAgents} />
                      )}
                      {!workspaceId && canManageOrg && (
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
                        <DropdownMenuContent
                          onClick={(e) => e.preventDefault()}
                        >
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
                          {!workspaceId && canManageOrg && (
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
      )}

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
        open={!!orgSkillDetach.selected}
        onOpenChange={(open) => {
          if (!open) orgSkillDetach.close();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Organization Skill</DialogTitle>
            <DialogDescription>
              The skill <strong>{orgSkillDetach.selected?.name}</strong> is
              managed at the organization level. It can only be edited from the
              organization settings.
            </DialogDescription>
          </DialogHeader>
          {orgSkillDetach.error && (
            <p className="text-sm text-destructive">{orgSkillDetach.error}</p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={orgSkillDetach.close}>
              Close
            </Button>
            {canAttach && orgSkillDetach.selected && (
              <Button
                variant="destructive"
                disabled={detaching}
                onClick={() => detachOrgSkill(orgSkillDetach.selected!.id)}
              >
                <Unlink className="size-4" />
                Detach
              </Button>
            )}
            {canAttach && orgSkillDetach.selected && (
              <Button asChild>
                <Link
                  href={`/${orgId}/settings/skills/${orgSkillDetach.selected.id}`}
                >
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

      <DeleteConfirmDialog
        open={deleteFlow.open}
        onOpenChange={(open) => !open && deleteFlow.close()}
        title="Delete Skill"
        description={`Are you sure you want to delete "${deleteFlow.target?.name}"? This action cannot be undone.`}
        onConfirm={deleteFlow.confirm}
        loading={deleteFlow.deleting}
        error={deleteFlow.error}
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
