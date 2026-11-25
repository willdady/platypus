"use client";

import { useState } from "react";
import { ItemActions } from "@/components/ui/item";
import { Button } from "@/components/ui/button";
import { AgentAvatar } from "@/components/agent-avatar";
import { CloneDialog } from "@/components/clone-dialog";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { EmptyCard } from "@/components/empty-card";
import { EntityCardList } from "@/components/entity-card-list";
import {
  ButtonRowSkeleton,
  CardGridSkeleton,
  IconButtonSkeleton,
  SkeletonLine,
} from "@/components/list-skeletons";
import { Skeleton } from "@/components/ui/skeleton";
import { RowActionsMenu, type RowAction } from "@/components/row-actions-menu";
import { CountTooltip } from "@/components/count-tooltip";
import {
  ArrowUpFromLine,
  Bot,
  BotMessageSquare,
  Pin,
  PinOff,
  Plus,
  Wrench,
  Sparkles,
} from "lucide-react";
import {
  agentCreateSchema,
  AGENT_NAME_MAX_LENGTH,
  type Agent,
  type AgentResponse,
  type ToolSet,
  type Skill,
} from "@platypus/schemas";
import { useScopedList } from "@/hooks/use-scoped-list";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth, useBackendUrl } from "@/components/auth-provider";
import {
  canCreateAgent,
  canManageSharedResource,
  canPinAgent,
} from "@/lib/authorization";
import { ListError } from "@/components/list-state";
import {
  AttachSharedAction,
  DetachSharedDialog,
  PromoteSharedDialog,
} from "@/components/shared-resource-actions";
import {
  scopedUrl,
  writeAt,
  writeEntity,
  type Scope,
  type Serialized,
} from "@/lib/api-write";
import { parseCloneBody } from "@/lib/parse-write-body";
import { splitPinned } from "@/lib/pinned-agents";
import { pickKeys, sortByName } from "@/lib/utils";
import { ListFooter, ListPagination } from "@/components/list-pagination";
import {
  usePromoteShared,
  useSharedDetach,
} from "@/hooks/use-shared-resource-actions";
import { useDeleteFlow } from "@/hooks/use-delete-flow";
import { useListParams } from "@/hooks/use-list-params";
import { useOptimisticRows } from "@/hooks/use-optimistic-rows";
import { orgRoutes, workspaceRoutes } from "@/lib/routes";

type SerializedAgent = Serialized<AgentResponse>;

const agentCardActionsClassName =
  "basis-full justify-between pl-16 xl:basis-auto xl:pl-0";

export function AgentCardsSkeleton({ cards }: { cards?: number }) {
  return (
    <CardGridSkeleton
      cards={cards}
      media
      className="items-stretch"
      extra={
        <div className="flex gap-3 mt-auto">
          {["w-16", "w-14", "w-20"].map((width) => (
            <SkeletonLine
              key={width}
              lineClassName="h-4"
              className={`h-3 ${width}`}
            />
          ))}
        </div>
      }
      actions={
        <ItemActions className={agentCardActionsClassName}>
          <Skeleton className="h-8 w-24" />
          <IconButtonSkeleton />
        </ItemActions>
      }
    />
  );
}

const AGENTS_PAGE_SIZE = 8;

export function AgentsList({
  orgId,
  workspaceId,
}: {
  orgId: string;
  workspaceId: string;
}) {
  const { actor, ownsWorkspace } = useAuth();
  const backendUrl = useBackendUrl();
  const router = useRouter();
  const [agentToClone, setAgentToClone] = useState<SerializedAgent | null>(
    null,
  );
  const { page: pageItems } = useListParams("agentsPage");

  const scope: Scope = { orgId, workspaceId };
  const routes = workspaceRoutes(orgId, workspaceId);

  const {
    data: agentsData,
    results: allAgents,
    error: agentsError,
    isLoading,
    mutate,
  } = useScopedList<SerializedAgent>("agents", scope);

  const {
    results: toolSets,
    error: toolSetsError,
    isLoading: isLoadingToolSets,
    mutate: mutateToolSets,
  } = useScopedList<ToolSet>("tools", scope);

  const {
    results: skills,
    error: skillsError,
    isLoading: isLoadingSkills,
    mutate: mutateSkills,
  } = useScopedList<Skill>("skills", scope);

  const orgAgentDetach = useSharedDetach<SerializedAgent>({
    resourceType: "agent",
    scope,
    mutate,
  });

  const promote = usePromoteShared<SerializedAgent>({
    entity: "agents",
    scope,
    mutate,
  });

  const pins = useOptimisticRows<SerializedAgent>();
  const togglePin = (agent: SerializedAgent) => {
    if (!backendUrl) return;
    void pins.run(
      agent.id,
      { isPinned: !agent.isPinned },
      () =>
        writeAt(scopedUrl(backendUrl, `agents/${agent.id}/pin`, scope), {
          method: agent.isPinned ? "DELETE" : "PUT",
        }),
      mutate,
    );
  };

  const agents = sortByName(pins.apply(allAgents));
  const { pinned: pinnedAgents, unpinned: unpinnedAgents } =
    splitPinned(agents);
  const page = pageItems(unpinnedAgents, AGENTS_PAGE_SIZE);

  const canManageShared = canManageSharedResource(actor, workspaceId);
  const canPin = canPinAgent(ownsWorkspace);
  const canClone = canCreateAgent(ownsWorkspace);

  const getToolSetNames = (toolSetIds: string[]) => {
    if (toolSetIds.length === 0) return [];
    return toolSetIds
      .map((id) => toolSets.find((ts) => ts.id === id)?.name)
      .filter(Boolean) as string[];
  };

  const getSkillNames = (skillIds: string[]) => {
    if (skillIds.length === 0) return [];
    return skillIds
      .map((id) => skills.find((s) => s.id === id)?.name)
      .filter(Boolean) as string[];
  };

  const getSubAgentNames = (subAgentIds: string[]) => {
    if (subAgentIds.length === 0) return [];
    return subAgentIds
      .map((id) => agents.find((a) => a.id === id)?.name)
      .filter(Boolean) as string[];
  };

  const deleteFlow = useDeleteFlow<SerializedAgent>({
    mutate,
    guidanceOnForbidden: true,
    delete: (agent, url) => writeEntity(url, "agents", scope, { id: agent.id }),
  });

  const handleDeleteClick = (agent: SerializedAgent) => {
    deleteFlow.request(agent);
  };

  const cloneReferences = (agent: SerializedAgent) => {
    const keep = (ids: string[] | undefined, visible: { id: string }[]) =>
      ids?.filter((id) => visible.some((resource) => resource.id === id));
    const kept = {
      subAgentIds: keep(agent.subAgentIds, agents),
      skillIds: keep(agent.skillIds, skills),
      toolSetIds: keep(agent.toolSetIds, toolSets),
    };
    const dropped = (
      [
        ["sub-agent", agent.subAgentIds, kept.subAgentIds],
        ["skill", agent.skillIds, kept.skillIds],
        ["tool set", agent.toolSetIds, kept.toolSetIds],
      ] as const
    )
      .map(([noun, ids, keptIds]) => {
        const count = (ids?.length ?? 0) - (keptIds?.length ?? 0);
        return count && `${count} ${noun}${count === 1 ? "" : "s"}`;
      })
      .filter(Boolean);
    return { kept, dropped };
  };

  const createClone = (
    agent: SerializedAgent,
    references: ReturnType<typeof cloneReferences>["kept"],
    cloneName: string,
    url: string,
  ) => {
    const sanitizedData = Object.fromEntries(
      Object.entries({
        ...pickKeys(agent, agentCreateSchema.shape),
        ...references,
        name: cloneName,
      }).map(([key, value]) => [key, value === null ? undefined : value]),
    );

    // why: Object.fromEntries erases its keys, so re-parse against the strict create schema
    const parsed = parseCloneBody(
      agentCreateSchema,
      sanitizedData,
      "This Agent cannot be cloned.",
    );
    if (!parsed.ok) return Promise.resolve(parsed.outcome);

    return writeEntity<"agents", Agent>(url, "agents", scope, {
      data: parsed.data,
    });
  };

  const referencesReady =
    !isLoadingToolSets && !isLoadingSkills && !toolSetsError && !skillsError;

  const renderMenu = (agent: SerializedAgent) => {
    const isOrgScoped = agent.scope === "organization";
    const pinAction: RowAction[] = canPin
      ? [
          {
            label: agent.isPinned ? "Unpin" : "Pin",
            icon: agent.isPinned ? <PinOff /> : <Pin />,
            onSelect: () => togglePin(agent),
            disabled: pins.isPending(agent.id),
          },
        ]
      : [];

    if (isOrgScoped) {
      return (
        <RowActionsMenu
          name={agent.name}
          shared
          edit={
            canManageShared
              ? { href: orgRoutes(orgId).settings.agentDetail(agent.id) }
              : undefined
          }
          actions={pinAction}
          clone={
            canClone ? { onSelect: () => setAgentToClone(agent) } : undefined
          }
          remove={
            canManageShared
              ? { onSelect: () => orgAgentDetach.request(agent) }
              : undefined
          }
        />
      );
    }

    return (
      <RowActionsMenu
        name={agent.name}
        edit={{ href: routes.agents.detail(agent.id) }}
        actions={[
          ...pinAction,
          ...(canManageShared
            ? [
                {
                  label: "Promote to organization",
                  icon: <ArrowUpFromLine />,
                  onSelect: () => promote.open(agent),
                },
              ]
            : []),
        ]}
        clone={{ onSelect: () => setAgentToClone(agent) }}
        remove={{ onSelect: () => handleDeleteClick(agent) }}
      />
    );
  };

  // why: only references that resolve here — a detached one must drop out of count and tooltip
  const renderMeta = (agent: SerializedAgent) => {
    const toolSetNames = getToolSetNames(agent.toolSetIds);
    const skillNames = getSkillNames(agent.skillIds);
    const subAgentNames = getSubAgentNames(agent.subAgentIds);
    return (
      <div className="flex gap-3 mt-auto overflow-hidden text-xs text-muted-foreground">
        <CountTooltip
          icon={<Wrench className="size-3" />}
          noun="tool set"
          names={toolSetNames}
        />
        <CountTooltip
          icon={<Sparkles className="size-3" />}
          noun="skill"
          names={skillNames}
        />
        <CountTooltip
          icon={<Bot className="size-3" />}
          noun="sub-agent"
          names={subAgentNames}
        />
      </div>
    );
  };

  const cloneRefs = agentToClone && cloneReferences(agentToClone);

  const actions = (
    <>
      <Button variant={agents.length ? "outline" : "default"} asChild>
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
    </>
  );

  return (
    <>
      <EntityCardList
        items={page.items}
        groups={
          pinnedAgents.length
            ? [
                {
                  heading: (
                    <>
                      <Pin className="size-4" /> Pinned
                    </>
                  ),
                  items: pinnedAgents,
                  "aria-label": "Pinned agents",
                  separated: true,
                },
              ]
            : undefined
        }
        ghosts={page}
        isLoading={isLoading}
        error={agentsError}
        data={agentsData}
        subject="agents"
        onRetry={() => void mutate()}
        skeleton={
          <>
            <AgentCardsSkeleton />
            <ButtonRowSkeleton
              className="mt-4"
              widths={["w-36", ...(canManageShared ? ["w-44"] : [])]}
            />
          </>
        }
        empty={
          <EmptyCard
            icon={<Bot />}
            title="No agents yet"
            description="Create an agent to start chatting with it in this workspace."
            action={actions}
          />
        }
        aria-label="Agents"
        wrap={(agent, card) => card({ className: "items-stretch" })}
        media={(agent) => (
          <AgentAvatar agent={agent} className="size-12 self-start" />
        )}
        isShared={(agent) => agent.scope === "organization"}
        meta={renderMeta}
        actions={(agent) => (
          <Button size="sm" asChild>
            <Link href={routes.chat.forAgent(agent.id)}>
              <BotMessageSquare /> New chat
            </Link>
          </Button>
        )}
        actionsClassName={agentCardActionsClassName}
        menu={renderMenu}
      />

      {agents.length > 0 && (
        <ListFooter
          pagination={
            <ListPagination
              page={page}
              param="agentsPage"
              aria-label="Agents pages"
            />
          }
        >
          {actions}
        </ListFooter>
      )}

      <DetachSharedDialog
        detach={orgAgentDetach}
        noun="agent"
        canDetach={canManageShared}
        orgSettingsHref={(selected) =>
          orgRoutes(orgId).settings.agentDetail(selected.id)
        }
      />

      <PromoteSharedDialog promote={promote} noun="agent" />

      {cloneRefs && agentToClone && (
        <CloneDialog
          noun="agent"
          original={agentToClone.name}
          nameMaxLength={AGENT_NAME_MAX_LENGTH}
          onClose={() => setAgentToClone(null)}
          create={(name, url) =>
            createClone(agentToClone, cloneRefs.kept, name, url)
          }
          disabled={!referencesReady}
          note={
            toolSetsError || skillsError ? (
              <div className="flex flex-col gap-2">
                {toolSetsError ? (
                  <ListError
                    error={toolSetsError}
                    subject="tool sets"
                    onRetry={() => void mutateToolSets()}
                  />
                ) : null}
                {skillsError ? (
                  <ListError
                    error={skillsError}
                    subject="skills"
                    onRetry={() => void mutateSkills()}
                  />
                ) : null}
              </div>
            ) : !referencesReady ? (
              <p className="text-sm text-muted-foreground">
                Loading references…
              </p>
            ) : (
              cloneRefs.dropped.length > 0 && (
                <p className="text-sm text-muted-foreground">
                  Not included, as not attached to this workspace:{" "}
                  {cloneRefs.dropped.join(", ")}.
                </p>
              )
            )
          }
          onCreated={(id) => {
            void mutate();
            router.push(routes.agents.detail(id));
          }}
        />
      )}

      <DeleteConfirmDialog
        noun="agent"
        name={deleteFlow.target?.name}
        {...deleteFlow.dialogProps}
      />
    </>
  );
}
