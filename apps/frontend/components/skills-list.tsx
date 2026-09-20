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
  Building,
  EllipsisVertical,
  Pencil,
  Plus,
  Share2,
  Trash2,
  TriangleAlert,
  UserRound,
} from "lucide-react";
import { type Skill, type Agent } from "@platypus/schemas";
import { useScopedSWR } from "@/hooks/use-scoped-swr";
import Link from "next/link";
import { useAuth } from "@/components/auth-provider";
import {
  canManageOrgSharedResource,
  canManageSharedResource,
} from "@/lib/authorization";
import {
  ManageAttachmentsDialog,
  SharedWithBadge,
} from "@/components/manage-sharing";
import {
  AttachSharedAction,
  DeleteBlockedDialog,
  DetachSharedDialog,
  PromoteSharedDialog,
} from "@/components/shared-resource-actions";
import { writeEntity, type Scope } from "@/lib/api-write";
import {
  usePromoteShared,
  useSharedDeleteGuard,
  useSharedDetach,
} from "@/hooks/use-shared-resource-actions";
import { useDeleteFlow } from "@/hooks/use-delete-flow";
import { orgRoutes, workspaceRoutes } from "@/lib/routes";

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
  const [skillToManage, setSkillToManage] = useState<SkillWithScope | null>(
    null,
  );

  // Resolved once per render and reused for the list's read and every write
  // below, rather than re-deriving the Organization-vs-Workspace branch at
  // each call site.
  const scope: Scope = workspaceId ? { orgId, workspaceId } : { orgId };
  const editBasePath = workspaceId
    ? workspaceRoutes(orgId, workspaceId).skills.root
    : orgRoutes(orgId).settings.skills;

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

  const orgSkillDetach = useSharedDetach<SkillWithScope>({
    resourceType: "skill",
    scope,
    mutate,
  });

  const promote = usePromoteShared<SkillWithScope>({
    entity: "skills",
    scope,
    mutate,
  });

  const getAgentsForSkill = (skillId: string) =>
    agents.filter((agent) => agent.skillIds?.includes(skillId));

  const deleteFlow = useDeleteFlow<SkillWithScope>({
    mutate,
    guidanceOnForbidden: true,
    delete: (skill, url) => writeEntity(url, "skills", scope, { id: skill.id }),
  });

  // On the Organization surface a Shared Skill can't be deleted while attached
  // (ADR-0007); the guard explains the blocker up front instead of offering a
  // Delete button that is guaranteed to fail. Inside a Workspace there is
  // nothing to check — the row is either private or a locked Shared card.
  const deleteGuard = useSharedDeleteGuard<SkillWithScope>({
    resourceType: "skill",
    scope,
    onAllowed: deleteFlow.request,
  });

  const handleDeleteClick = (skill: SkillWithScope) =>
    workspaceId ? deleteFlow.request(skill) : deleteGuard.request(skill);

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
                              onSelect={() => promote.open(skill)}
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
        {canAttach && workspaceId && (
          <AttachSharedAction
            orgId={orgId}
            workspaceId={workspaceId}
            resourceType="skill"
            label="Attach shared skill"
            resources={skills}
            onAttached={mutate}
          />
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

      <DetachSharedDialog
        detach={orgSkillDetach}
        title="Organization Skill"
        description={(selected) => (
          <>
            The skill <strong>{selected.name}</strong> is managed at the
            organization level. It can only be edited from the organization
            settings.
          </>
        )}
        canDetach={canAttach}
        orgSettingsHref={(selected) =>
          orgRoutes(orgId).settings.skillDetail(selected.id)
        }
      />

      <PromoteSharedDialog promote={promote} noun="skill" />

      <DeleteConfirmDialog
        open={deleteFlow.open}
        onOpenChange={(open) => !open && deleteFlow.close()}
        title="Delete Skill"
        description={`Are you sure you want to delete "${deleteFlow.target?.name}"? This action cannot be undone.`}
        onConfirm={deleteFlow.confirm}
        loading={deleteFlow.deleting}
        error={deleteFlow.error}
      />

      <DeleteBlockedDialog
        guard={deleteGuard}
        noun="skill"
        onManage={setSkillToManage}
      />
    </>
  );
};
