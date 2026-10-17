"use client";

import { useState } from "react";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Button } from "@/components/ui/button";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { ListError } from "@/components/list-state";
import { EmptyCard } from "@/components/empty-card";
import {
  CardGridSkeleton,
  IconButtonSkeleton,
  LoadingRegion,
  SkeletonLine,
} from "@/components/list-skeletons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Bot, EllipsisVertical, Pencil, Share2, Trash2 } from "lucide-react";
import { type Agent } from "@platypus/schemas";
import { useScopedList } from "@/hooks/use-scoped-list";
import { useAuth } from "@/components/auth-provider";
import { canManageOrgSharedResource } from "@/lib/authorization";
import {
  AttachmentCount,
  ManageAttachmentsDialog,
  SharedWithBadge,
  UnattachedWarning,
} from "@/components/manage-sharing";
import { DeleteBlockedDialog } from "@/components/shared-resource-actions";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { writeEntity, type Scope } from "@/lib/api-write";
import { useDeleteFlow } from "@/hooks/use-delete-flow";
import { orgRoutes } from "@/lib/routes";
import { useSharedDeleteGuard } from "@/hooks/use-shared-resource-actions";

// The Organization surface for Shared Agents (ADR-0007): Org Admins see and
// manage every Shared Agent, attached or not. Promotion (from a Workspace) is
// the way a Shared Agent is created; it is then edited, shared, and deleted
// here on the Organization surface — in Workspaces it is locked.
export const OrgAgentsList = ({ orgId }: { orgId: string }) => {
  const { actor } = useAuth();
  const canManage = canManageOrgSharedResource(actor);
  const [agentToManage, setAgentToManage] = useState<Agent | null>(null);

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

  const deleteFlow = useDeleteFlow<Agent>({
    mutate,
    delete: (agent, url) => writeEntity(url, "agents", scope, { id: agent.id }),
  });

  const deleteGuard = useSharedDeleteGuard<Agent>({
    resourceType: "agent",
    scope,
    onAllowed: deleteFlow.request,
  });

  if (isLoading) {
    return (
      <LoadingRegion label="Loading shared agents">
        <CardGridSkeleton
          media
          descriptionLines={2}
          extra={
            canManage && (
              // The "Shared with N workspaces" badge.
              <SkeletonLine lineClassName="mt-1 h-4" className="h-3 w-32" />
            )
          }
          // The row menu is an Org Admin's alone, as on the loaded card.
          actions={canManage ? <IconButtonSkeleton /> : null}
        />
      </LoadingRegion>
    );
  }

  if (error) {
    return <ListError error={error} subject="shared agents" />;
  }

  if (agents.length === 0) {
    return (
      <EmptyCard
        icon={<Bot />}
        title="No shared agents yet"
        description="Promote a workspace agent to the organization to share it across workspaces."
      />
    );
  }

  return (
    <>
      <ul className="grid grid-cols-1 lg:grid-cols-2 gap-2 lg:gap-4">
        {agents.map((agent) => (
          <li key={agent.id}>
            <AttachmentCount
              orgId={canManage ? orgId : null}
              resourceType="agent"
              resourceId={agent.id}
            >
              {(count) => (
                <Item
                  variant="outline"
                  className={cn("h-full", count === 0 && "border-warning")}
                >
                  {agent.avatarUrl ? (
                    <ItemMedia variant="image" className="size-12 rounded-full">
                      {/* Agent avatar URL is user-supplied (arbitrary host); not
                      routable through the Next image optimizer. */}
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={agent.avatarUrl}
                        alt={agent.name}
                        className="size-full object-cover"
                        width={48}
                        height={48}
                        loading="lazy"
                        decoding="async"
                      />
                    </ItemMedia>
                  ) : (
                    <ItemMedia
                      variant="icon"
                      className="size-12 rounded-full [&_svg]:!size-7"
                    >
                      <Bot className="h-7 w-7 text-muted-foreground" />
                    </ItemMedia>
                  )}
                  <ItemContent>
                    <ItemTitle>{agent.name}</ItemTitle>
                    <ItemDescription className="text-xs line-clamp-3">
                      {agent.description}
                    </ItemDescription>
                    {canManage && (
                      <div className="mt-1">
                        <SharedWithBadge
                          orgId={orgId}
                          resourceType="agent"
                          resourceId={agent.id}
                        />
                      </div>
                    )}
                    {count === 0 && <UnattachedWarning />}
                  </ItemContent>
                  {canManage && (
                    <ItemActions>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            className="text-muted-foreground"
                            variant="ghost"
                            size="icon"
                            aria-label={`Actions for ${agent.name}`}
                          >
                            <EllipsisVertical className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent>
                          <DropdownMenuItem asChild>
                            <Link
                              href={orgRoutes(orgId).settings.agentDetail(
                                agent.id,
                              )}
                            >
                              <Pencil /> Edit
                            </Link>
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onSelect={() => setAgentToManage(agent)}
                          >
                            <Share2 /> Manage attachments
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            className="text-destructive focus:text-destructive"
                            onSelect={() => deleteGuard.request(agent)}
                          >
                            <Trash2 /> Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </ItemActions>
                  )}
                </Item>
              )}
            </AttachmentCount>
          </li>
        ))}
      </ul>

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
};
