"use client";

import { useState } from "react";
import { ALL } from "@/lib/search-params";
import { sortByName } from "@/lib/utils";
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
import { ListError, ListState } from "@/components/list-state";
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
} from "@/components/list-pagination";
import { ListToolbar } from "@/components/list-toolbar";
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
import { type SkillResponse, type Agent } from "@platypus/schemas";
import { useListParams, useSearchParamInput } from "@/hooks/use-list-params";
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

type SerializedSkill = Serialized<SkillResponse>;

const UNATTACHED = "unattached";
const SKILLS_PAGE_SIZE = 8;

function UserInvocableBadge({ skill }: { skill: SerializedSkill }) {
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

function SkillAgentsIndicator({
  agents,
  unavailable = false,
}: {
  agents: Serialized<Agent>[];
  unavailable?: boolean;
}) {
  return (
    <div className="mt-1 flex h-4 items-center text-xs text-muted-foreground">
      {unavailable ? null : agents.length > 0 ? (
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

export function SkillCardsSkeleton({
  cards,
  agentLine = false,
  sharingLines = false,
}: {
  cards?: number;
  agentLine?: boolean;
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
  const [skillToManage, setSkillToManage] = useState<SerializedSkill | null>(
    null,
  );
  const { get, set, page: pageItems } = useListParams("skillsPage");
  const agentFilter = (workspaceId && get("skillAgent")) || ALL;
  const { value: nameFilter, onValueChange: setNameFilter } =
    useSearchParamInput("skillQuery", "skillsPage");
  const setAgentFilter = (value: string) =>
    set("skillAgent", value === ALL ? null : value);

  const scope: Scope = workspaceId ? { orgId, workspaceId } : { orgId };
  const editBasePath = workspaceId
    ? workspaceRoutes(orgId, workspaceId).skills.root
    : orgRoutes(orgId).settings.skills;

  const {
    data,
    results: skillRows,
    error,
    isLoading,
    mutate,
  } = useScopedList<SerializedSkill>("skills", scope);

  const {
    data: agentsData,
    results: agents,
    error: agentsError,
    isLoading: isLoadingAgents,
    mutate: mutateAgents,
  } = useScopedList<Agent>("agents", workspaceId ? scope : null);

  const agentsFailed = Boolean(workspaceId && agentsError && !agentsData);
  const agentsUnavailable =
    Boolean(workspaceId) && (isLoadingAgents || agentsFailed);

  const skills = sortByName(skillRows);

  const canAttach = canManageSharedResource(actor, workspaceId);
  const canPromote = canAttach;
  const canManageOrg = canManageOrgSharedResource(actor);
  const importAllowed = useSkillImportAllowed(scope);

  const orgSkillDetach = useSharedDetach<SerializedSkill>({
    resourceType: "skill",
    scope,
    mutate,
  });

  const promote = usePromoteShared<SerializedSkill>({
    entity: "skills",
    scope,
    mutate,
  });

  const getAgentsForSkill = (skillId: string) =>
    agents.filter((agent) => agent.skillIds.includes(skillId));

  const deleteFlow = useDeleteFlow<SerializedSkill>({
    mutate,
    guidanceOnForbidden: true,
    delete: (skill, url) => writeEntity(url, "skills", scope, { id: skill.id }),
  });

  const deleteGuard = useSharedDeleteGuard<SerializedSkill>({
    resourceType: "skill",
    scope,
    onAllowed: deleteFlow.request,
  });

  const handleDeleteClick = (skill: SerializedSkill) =>
    workspaceId ? deleteFlow.request(skill) : deleteGuard.request(skill);

  const isSharedInWorkspace = (skill: SerializedSkill) =>
    Boolean(workspaceId) && skill.scope === "organization";

  const renderMenu = (skill: SerializedSkill) => {
    if (isSharedInWorkspace(skill)) {
      return canAttach ? (
        <RowActionsMenu
          name={skill.name}
          shared
          edit={{ href: orgRoutes(orgId).settings.skillDetail(skill.id) }}
          remove={{ onSelect: () => orgSkillDetach.request(skill) }}
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

  const agentOptions = agents.filter((agent) =>
    skills.some((skill) => agent.skillIds.includes(skill.id)),
  );

  const activeAgentFilter =
    agentFilter === UNATTACHED ||
    agentOptions.some((agent) => agent.id === agentFilter)
      ? agentFilter
      : ALL;

  const query = workspaceId ? nameFilter.trim() : "";
  const matchesAgent = (skill: SerializedSkill) => {
    if (activeAgentFilter === ALL) return true;
    const skillAgents = getAgentsForSkill(skill.id);
    return activeAgentFilter === UNATTACHED
      ? skillAgents.length === 0
      : skillAgents.some((agent) => agent.id === activeAgentFilter);
  };
  const shown = skills.filter(
    (skill) =>
      (!query || defaultFilter(skill.name, query) > 0) && matchesAgent(skill),
  );

  const controls = workspaceId && skills.length > 0 && (
    <ListToolbar>
      <SearchInput
        placeholder="Search skills..."
        aria-label="Search skills"
        value={nameFilter}
        onValueChange={setNameFilter}
        className="w-full sm:w-64"
      />
      <Select
        value={activeAgentFilter}
        onValueChange={setAgentFilter}
        disabled={agentsUnavailable}
      >
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
    </ListToolbar>
  );

  const showEmptyCard = !workspaceId && skills.length === 0;

  const showFooter = Boolean(workspaceId) || !showEmptyCard;

  const actions = (
    <>
      <Button variant={showEmptyCard ? "default" : "outline"} asChild>
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

  const page = workspaceId
    ? pageItems(shown, SKILLS_PAGE_SIZE)
    : { items: shown, page: 1, pageCount: 1, ...NO_GHOSTS };

  return (
    <>
      {controls}
      {agentsFailed && (
        <div className="mb-4">
          <ListError
            error={agentsError}
            subject="agents"
            onRetry={() => void mutateAgents()}
          />
        </div>
      )}
      <EntityCardList
        items={page.items}
        ghosts={page}
        isLoading={isLoading}
        error={error}
        data={data}
        subject="skills"
        onRetry={() => void mutate()}
        skeleton={
          <>
            <SkillCardsSkeleton
              agentLine={Boolean(workspaceId)}
              sharingLines={!workspaceId && canManageOrg}
            />
            {!workspaceId && (
              // why: only the Organization footer needs reserving; the other shows always
              <ButtonRowSkeleton className="mt-4" widths={["w-32"]} />
            )}
          </>
        }
        empty={
          showEmptyCard ? (
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
            <SkillAgentsIndicator
              agents={getAgentsForSkill(skill.id)}
              unavailable={agentsUnavailable}
            />
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
                      ? !agentsUnavailable &&
                        getAgentsForSkill(skill.id).length === 0
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

      {showFooter && (
        <ListFooter
          className={workspaceId ? undefined : "mt-4"}
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

      <ManageAttachmentsDialog
        orgId={orgId}
        resourceType="skill"
        resource={skillToManage}
        onClose={() => setSkillToManage(null)}
      />

      <DetachSharedDialog
        detach={orgSkillDetach}
        noun="skill"
        canDetach={canAttach}
        orgSettingsHref={(selected) =>
          orgRoutes(orgId).settings.skillDetail(selected.id)
        }
      />

      <PromoteSharedDialog promote={promote} noun="skill" />

      <DeleteConfirmDialog
        noun="skill"
        name={deleteFlow.target?.name}
        {...deleteFlow.dialogProps}
      />

      <DeleteBlockedDialog
        guard={deleteGuard}
        noun="skill"
        onManage={setSkillToManage}
      />
    </>
  );
}
