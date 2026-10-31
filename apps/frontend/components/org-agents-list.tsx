"use client";

import { useState } from "react";
import { AgentAvatar } from "@/components/agent-avatar";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { EmptyCard } from "@/components/empty-card";
import { EntityCardList } from "@/components/entity-card-list";
import {
  CardGridSkeleton,
  IconButtonSkeleton,
  SkeletonLine,
} from "@/components/list-skeletons";
import { RowActionsMenu } from "@/components/row-actions-menu";
import { Bot, Share2 } from "lucide-react";
import { type Agent } from "@platypus/schemas";
import { useScopedList } from "@/hooks/use-scoped-list";
import { useAuth } from "@/components/auth-provider";
import { canManageOrgSharedResource } from "@/lib/authorization";
import {
  AttachmentCount,
  ManageAttachmentsDialog,
  SharedWithBadge,
  UnattachedWarningLine,
} from "@/components/manage-sharing";
import { DeleteBlockedDialog } from "@/components/shared-resource-actions";
import { writeEntity, type Scope, type Serialized } from "@/lib/api-write";
import { useDeleteFlow } from "@/hooks/use-delete-flow";
import { orgRoutes } from "@/lib/routes";
import { useSharedDeleteGuard } from "@/hooks/use-shared-resource-actions";

// The Organization surface for Shared Agents (ADR-0007): Org Admins see and
// manage every Shared Agent, attached or not. Promotion (from a Workspace) is
// the way a Shared Agent is created; it is then edited, shared, and deleted
// here on the Organization surface — in Workspaces it is locked.
export function OrgAgentsList({ orgId }: { orgId: string }) {
  const { actor } = useAuth();
  const canManage = canManageOrgSharedResource(actor);
  const [agentToManage, setAgentToManage] = useState<Serialized<Agent> | null>(
    null,
  );

  // Resolved once per render and reused for the list's read and every write
  // below, rather than re-deriving the Organization-vs-Workspace branch at
  // each call site.
  const scope: Scope = { orgId };

  const {
    results: rows,
    error,
    isLoading,
    mutate,
  } = useScopedList<Agent>("agents", scope);

  const agents = [...rows].sort((a, b) => a.name.localeCompare(b.name));

  const deleteFlow = useDeleteFlow<Serialized<Agent>>({
    mutate,
    delete: (agent, url) => writeEntity(url, "agents", scope, { id: agent.id }),
  });

  const deleteGuard = useSharedDeleteGuard<Serialized<Agent>>({
    resourceType: "agent",
    scope,
    onAllowed: deleteFlow.request,
  });

  return (
    <>
      <EntityCardList
        items={agents}
        isLoading={isLoading}
        error={error}
        subject="shared agents"
        onRetry={() => void mutate()}
        skeleton={
          <CardGridSkeleton
            media
            extra={
              canManage && (
                <>
                  {/* The "Shared with N workspaces" badge. */}
                  <SkeletonLine lineClassName="mt-1 h-4" className="h-3 w-32" />
                  {/* The unattached warning's reserved line. */}
                  <div className="mt-1 h-4" />
                </>
              )
            }
            // The row menu is an Org Admin's alone, as on the loaded card.
            actions={canManage ? <IconButtonSkeleton /> : null}
          />
        }
        empty={
          <EmptyCard
            icon={<Bot />}
            title="No shared agents yet"
            description="Promote a workspace agent to the organization to share it across workspaces."
          />
        }
        media={(agent) => (
          <AgentAvatar agent={agent} className="size-12 self-start" />
        )}
        meta={(agent) =>
          canManage && (
            <div className="mt-1">
              <SharedWithBadge
                orgId={orgId}
                resourceType="agent"
                resourceId={agent.id}
              />
            </div>
          )
        }
        menu={
          canManage
            ? (agent) => (
                <RowActionsMenu
                  name={agent.name}
                  edit={{
                    href: orgRoutes(orgId).settings.agentDetail(agent.id),
                  }}
                  actions={[
                    {
                      label: "Manage attachments",
                      icon: <Share2 />,
                      onSelect: () => setAgentToManage(agent),
                    },
                  ]}
                  remove={{
                    onSelect: () => void deleteGuard.request(agent),
                  }}
                />
              )
            : undefined
        }
        wrap={(agent, card) => (
          <AttachmentCount
            orgId={canManage ? orgId : null}
            resourceType="agent"
            resourceId={agent.id}
          >
            {(count) =>
              card({
                className: count === 0 ? "border-warning" : undefined,
                meta: canManage && <UnattachedWarningLine count={count} />,
              })
            }
          </AttachmentCount>
        )}
      />

      {agentToManage && (
        <ManageAttachmentsDialog
          orgId={orgId}
          resourceType="agent"
          resourceId={agentToManage.id}
          resourceName={agentToManage.name}
          open={!!agentToManage}
          onOpenChange={(open) => !open && setAgentToManage(null)}
        />
      )}

      <DeleteConfirmDialog
        open={deleteFlow.open}
        onOpenChange={(open) => !open && deleteFlow.close()}
        title="Delete shared agent"
        description={`Delete "${deleteFlow.target?.name}"? This cannot be undone.`}
        onConfirm={deleteFlow.confirm}
        loading={deleteFlow.deleting}
        error={deleteFlow.error}
      />

      <DeleteBlockedDialog
        guard={deleteGuard}
        noun="agent"
        onManage={setAgentToManage}
      />
    </>
  );
}
