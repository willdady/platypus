"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { replaceSearchParam } from "@/lib/search-params";
import { defaultFilter } from "cmdk";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EntityCardList } from "@/components/entity-card-list";
import { SearchInput } from "@/components/search-input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { ListState } from "@/components/list-state";
import { EmptyCard } from "@/components/empty-card";
import {
  ButtonRowSkeleton,
  CardGridSkeleton,
  SkeletonLine,
} from "@/components/list-skeletons";
import {
  ListFooter,
  ListPagination,
  NO_GHOSTS,
  pageOf,
} from "@/components/list-pagination";
import { RowActionsMenu } from "@/components/row-actions-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  ArrowUpFromLine,
  Bot,
  FolderGit2,
  Plus,
  Share2,
  Sparkles,
  TriangleAlert,
  UserRound,
} from "lucide-react";
import { type Skill, type Agent } from "@platypus/schemas";
import { useScopedList } from "@/hooks/use-scoped-list";
import { useSkillImportAllowed } from "@/hooks/use-skill-import-allowed";
import Link from "next/link";
import { useAuth } from "@/components/auth-provider";
import {
  canManageOrgSharedResource,
  canManageSharedResource,
} from "@/lib/authorization";
import {
  ManageAttachmentsDialog,
  AttachmentCount,
  SharedWithBadge,
  UnattachedWarningLine,
} from "@/components/manage-sharing";
import {
  AttachSharedAction,
  DeleteBlockedDialog,
  DetachSharedDialog,
  PromoteSharedDialog,
} from "@/components/shared-resource-actions";
import { writeEntity, type Scope, type Serialized } from "@/lib/api-write";
import {
  usePromoteShared,
  useSharedDeleteGuard,
  useSharedDetach,
} from "@/hooks/use-shared-resource-actions";
import { useDeleteFlow } from "@/hooks/use-delete-flow";
import { orgRoutes, workspaceRoutes } from "@/lib/routes";
import {
  NeedsSandboxBadge,
  SkillImportButton,
} from "@/components/skill-bundle";

// The list serves two surfaces: a Workspace (workspaceId provided) where it
// shows workspace-scoped Skills plus attached org-scoped Shared Skills as
// locked cards, and the Organization settings surface (no workspaceId) where it
// manages org-scoped Skills directly (ADR-0007).
type SkillWithScope = Serialized<Skill> & {
  scope?: "organization" | "workspace";
};

/** The value a Select carries for "no filter" — Radix rejects an empty one. */
const ALL = "all";
/** The agent-filter value for Skills attached to no agent. */
const UNATTACHED = "unattached";
/** Skills per page on the Workspace home. */
const SKILLS_PAGE_SIZE = 8;

function UserInvocableBadge({ skill }: { skill: SkillWithScope }) {
  if (!skill.disableModelInvocation) return null;

  return (
    <Badge
      variant="pill"
      title="This skill is only invoked when a user triggers it"
    >
      <UserRound />
      User-invocable only
    </Badge>
  );
}

// The agent-association indicator shown on workspace skill cards: a Bot icon
// with an "N agent(s)" count whose tooltip lists the agents, or a warning when
// the Skill is attached to no agents. Rendered for both workspace-scoped and
// attached org-scoped (Shared) Skills (#296). The trigger uses preventDefault
// so tapping the count does not follow the card's link.
function SkillAgentsIndicator({ agents }: { agents: Serialized<Agent>[] }) {
  return (
    <div className="mt-1 flex h-4 items-center text-xs text-muted-foreground">
      {agents.length > 0 ? (
        <Tooltip>
          <TooltipTrigger
            className="flex items-center gap-1 cursor-default whitespace-nowrap"
            onClick={(e) => e.preventDefault()}
          >
            <Bot className="size-3" />
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
        <span
          className="flex min-w-0 items-center gap-1 cursor-default text-warning-foreground"
          title="WARNING: Skill not associated with any agents."
        >
          <TriangleAlert className="size-3 shrink-0" />
          <span className="truncate">
            <strong>WARNING:</strong> Skill not associated with any agents.
          </span>
        </span>
      )}
    </div>
  );
}

/**
 * The skill cards as they load; the workspace home draws them too. Each line
 * the loaded card reserves is drawn, so the list doesn't jump as it lands.
 */
export function SkillCardsSkeleton({
  cards,
  agentLine = false,
  sharingLines = false,
}: {
  cards?: number;
  /** A workspace card's agent count. */
  agentLine?: boolean;
  /** An Org Admin's "Shared with" badge and unattached warning. */
  sharingLines?: boolean;
}) {
  return (
    <CardGridSkeleton
      cards={cards}
      extra={
        <>
          {(agentLine || sharingLines) && (
            <SkeletonLine lineClassName="mt-1 h-4" className="h-3 w-24" />
          )}
          {sharingLines && <div className="mt-1 h-4" />}
        </>
      }
    />
  );
}

export function SkillsList({
  orgId,
  workspaceId,
}: {
  orgId: string;
  workspaceId?: string;
}) {
  const { actor } = useAuth();
  const [skillToManage, setSkillToManage] = useState<SkillWithScope | null>(
    null,
  );
  const searchParams = useSearchParams();

  // Both filters live in the URL, so they survive a refresh and Back. Only the
  // Workspace home shows the controls; elsewhere the params are ignored.
  const agentFilter = (workspaceId && searchParams.get("skillAgent")) || ALL;
  // The input reads local state, seeded from the URL: the URL write below
  // lands a render later, and an input bound straight to it drops keystrokes.
  const [nameFilter, setNameFilterState] = useState(
    () => (workspaceId && searchParams.get("skillQuery")) || "",
  );

  // A default value leaves its param out. A new filter starts on page 1.
  const setNameFilter = (value: string) => {
    setNameFilterState(value);
    replaceSearchParam("skillQuery", value.trim() || null);
    replaceSearchParam("skillsPage", null);
  };
  const setAgentFilter = (value: string) => {
    replaceSearchParam("skillAgent", value === ALL ? null : value);
    replaceSearchParam("skillsPage", null);
  };

  // Resolved once per render and reused for the list's read and every write
  // below, rather than re-deriving the Organization-vs-Workspace branch at
  // each call site.
  const scope: Scope = workspaceId ? { orgId, workspaceId } : { orgId };
  const editBasePath = workspaceId
    ? workspaceRoutes(orgId, workspaceId).skills.root
    : orgRoutes(orgId).settings.skills;

  const {
    results: skillRows,
    error,
    isLoading,
    mutate,
  } = useScopedList<SkillWithScope>("skills", scope);

  // Agent associations are a workspace concern; only fetched on that surface.
  const { results: agents } = useScopedList<Agent>(
    "agents",
    workspaceId ? scope : null,
  );

  const skills = [...skillRows].sort((a, b) => a.name.localeCompare(b.name));

  // Attach, detach, and Promote a Shared resource are the same rule
  // (ADR-0007 / #154), asked of the auth module instead of re-derived here.
  const canAttach = canManageSharedResource(actor, workspaceId);
  const canPromote = canAttach;
  const canManageOrg = canManageOrgSharedResource(actor);
  const importAllowed = useSkillImportAllowed(scope);

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

  // Org-scoped (Shared) Skills are locked inside a Workspace: they can only
  // be edited from the organization settings surface (ADR-0007).
  const isSharedInWorkspace = (skill: SkillWithScope) =>
    Boolean(workspaceId) && skill.scope === "organization";

  const renderMenu = (skill: SkillWithScope) => {
    if (isSharedInWorkspace(skill)) {
      // Like a Shared Agent: Detach is named in the menu rather than behind
      // the card's own click, and only an Org Admin gets one.
      return canAttach ? (
        <RowActionsMenu
          name={skill.name}
          shared
          edit={{ href: orgRoutes(orgId).settings.skillDetail(skill.id) }}
          remove={{ onSelect: () => orgSkillDetach.open(skill) }}
        />
      ) : null;
    }

    return (
      <RowActionsMenu
        name={skill.name}
        edit={{ href: `${editBasePath}/${skill.id}` }}
        actions={[
          ...(canPromote
            ? [
                {
                  label: "Promote to organization",
                  icon: <ArrowUpFromLine />,
                  onSelect: () => promote.open(skill),
                },
              ]
            : []),
          ...(!workspaceId && canManageOrg
            ? [
                {
                  label: "Manage attachments",
                  icon: <Share2 />,
                  onSelect: () => setSkillToManage(skill),
                },
              ]
            : []),
        ]}
        remove={{ onSelect: () => void handleDeleteClick(skill) }}
      />
    );
  };

  // The Command palette's own scorer, applied to the name: a card grid, not a
  // `Command` list, so it is called directly rather than through `Command`.
  // Only agents that would narrow the list to something are worth offering.
  const agentOptions = agents.filter((agent) =>
    skills.some((skill) => agent.skillIds?.includes(skill.id)),
  );

  // A chosen agent that has since dropped out of the options (detached from
  // its last Skill, or deleted) reads as no filter, rather than leaving a
  // blank select over an empty list.
  const activeAgentFilter =
    agentFilter === UNATTACHED ||
    agentOptions.some((agent) => agent.id === agentFilter)
      ? agentFilter
      : ALL;

  const query = nameFilter.trim();
  const matchesAgent = (skill: SkillWithScope) => {
    if (activeAgentFilter === ALL) return true;
    const skillAgents = getAgentsForSkill(skill.id);
    return activeAgentFilter === UNATTACHED
      ? skillAgents.length === 0
      : skillAgents.some((agent) => agent.id === activeAgentFilter);
  };
  // The Command palette's own scorer, applied to the name: a card grid, not a
  // `Command` list, so it is called directly rather than through `Command`.
  const shown = skills.filter(
    (skill) =>
      (!query || defaultFilter(skill.name, query) > 0) && matchesAgent(skill),
  );

  // Workspace home only: the Organization surface fetches no agent data, so
  // the agent filter would have nothing to offer there. Nothing to filter, no
  // controls.
  const controls = !isLoading && !error && workspaceId && skills.length > 0 && (
    <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2">
      <SearchInput
        placeholder="Search skills…"
        aria-label="Search skills"
        value={nameFilter}
        onValueChange={setNameFilter}
        className="w-full sm:w-64"
      />
      <Select value={activeAgentFilter} onValueChange={setAgentFilter}>
        <SelectTrigger className="w-44" aria-label="Filter by agent">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>Any agent</SelectItem>
          {agentOptions.map((agent) => (
            <SelectItem key={agent.id} value={agent.id}>
              {agent.name}
            </SelectItem>
          ))}
          <SelectItem value={UNATTACHED}>Unattached</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );

  // The Organization's own Skills screen shows the empty card, holding the
  // buttons; the workspace home's Skills section keeps the one-line state.
  const showCard = !workspaceId && skills.length === 0;

  const actions = (
    <>
      <Button variant={showCard ? "default" : "outline"} asChild>
        <Link href={`${editBasePath}/create`}>
          <Plus /> Create skill
        </Link>
      </Button>
      {importAllowed && (
        <>
          <SkillImportButton scope={scope} onImported={() => void mutate()} />
          <Button variant="outline" asChild>
            <Link href={`${editBasePath}/install`}>
              <FolderGit2 /> Install from GitHub
            </Link>
          </Button>
        </>
      )}
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
    </>
  );

  // Paged on the Workspace home only; the Organization surface lists them all.
  const page = workspaceId
    ? pageOf(searchParams.get("skillsPage"), shown, SKILLS_PAGE_SIZE)
    : { items: shown, page: 1, pageCount: 1, ...NO_GHOSTS };

  return (
    <>
      {controls}
      <EntityCardList
        items={page.items}
        ghosts={page}
        isLoading={isLoading}
        error={error}
        subject="skills"
        onRetry={() => void mutate()}
        skeleton={
          <>
            <SkillCardsSkeleton
              agentLine={Boolean(workspaceId)}
              sharingLines={!workspaceId && canManageOrg}
            />
            <ButtonRowSkeleton
              className="mt-4"
              widths={["w-32", ...(canAttach && workspaceId ? ["w-44"] : [])]}
            />
          </>
        }
        empty={
          showCard ? (
            <EmptyCard
              icon={<Sparkles />}
              title="No skills yet"
              description="Create or import a skill to give your agents packaged know-how they load when a task needs it."
              action={actions}
            />
          ) : skills.length === 0 ? (
            <ListState variant="empty">No skills yet.</ListState>
          ) : (
            <ListState variant="empty">No skills match your filters.</ListState>
          )
        }
        href={(skill) => `${editBasePath}/${skill.id}`}
        isShared={isSharedInWorkspace}
        badges={(skill) => (
          <>
            <UserInvocableBadge skill={skill} />
            <NeedsSandboxBadge skill={skill} />
          </>
        )}
        meta={(skill) =>
          workspaceId ? (
            <SkillAgentsIndicator agents={getAgentsForSkill(skill.id)} />
          ) : (
            canManageOrg && (
              <div className="mt-1">
                <SharedWithBadge
                  orgId={orgId}
                  resourceType="skill"
                  resourceId={skill.id}
                />
              </div>
            )
          )
        }
        menu={renderMenu}
        wrap={(skill, card) =>
          isSharedInWorkspace(skill) ? (
            card()
          ) : (
            <AttachmentCount
              orgId={!workspaceId && canManageOrg ? orgId : null}
              resourceType="skill"
              resourceId={skill.id}
            >
              {(count) =>
                card({
                  className: (
                    workspaceId
                      ? getAgentsForSkill(skill.id).length === 0
                      : count === 0
                  )
                    ? "border-warning"
                    : undefined,
                  meta: !workspaceId && canManageOrg && (
                    <UnattachedWarningLine count={count} />
                  ),
                })
              }
            </AttachmentCount>
          )
        }
      />

      {!isLoading && !error && !showCard && (
        <ListFooter
          className="mt-4"
          pagination={
            <ListPagination
              page={page}
              param="skillsPage"
              aria-label="Skills pages"
            />
          }
        >
          {actions}
        </ListFooter>
      )}

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
        title="Detach shared skill"
        description={(selected) => (
          <>
            Detach <strong>{selected.name}</strong> from this workspace? The
            shared skill itself is not deleted; it just stops appearing here.
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
}
