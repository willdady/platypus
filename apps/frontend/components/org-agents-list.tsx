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
import { ListError, ListState } from "@/components/list-state";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Bot, EllipsisVertical, Pencil, Share2, Trash2 } from "lucide-react";
import { type Agent } from "@platypus/schemas";
import { useScopedSWR } from "@/hooks/use-scoped-swr";
import { useAuth } from "@/components/auth-provider";
import { canManageOrgSharedResource } from "@/lib/authorization";
import {
  ManageAttachmentsDialog,
  SharedWithBadge,
} from "@/components/manage-sharing";
import { DeleteBlockedDialog } from "@/components/shared-resource-actions";
import Link from "next/link";
import { writeEntity, type Scope } from "@/lib/api-write";
import { useDeleteFlow } from "@/hooks/use-delete-flow";
import { useSharedDeleteGuard } from "@/hooks/use-shared-resource-actions";

// The Organization surface for Shared Agents (ADR-0007): Org Admins see and
// manage every Shared Agent, attached or not. Promotion (from a Workspace) is
// the way a Shared Agent is created; it is then edited, shared, and deleted
// here on the Organization surface — in Workspaces it is locked.
export const OrgAgentsList = ({ orgId }: { orgId: string }) => {
  const { actor } = useAuth();
  const canManage = canManageOrgSharedResource(actor).allowed;
  const [agentToManage, setAgentToManage] = useState<Agent | null>(null);

  // Resolved once per render and reused for the list's read and every write
  // below, rather than re-deriving the Organization-vs-Workspace branch at
  // each call site.
  const scope: Scope = { orgId };

  const { data, error, isLoading, mutate } = useScopedSWR<{ results: Agent[] }>(
    "agents",
    scope,
  );

  const agents = [...(data?.results || [])].sort((a, b) =>
    a.name.localeCompare(b.name),
  );

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
    return <ListState variant="loading">Loading...</ListState>;
  }

  if (error) {
    return <ListError error={error} subject="shared agents" />;
  }

  if (agents.length === 0) {
    return (
      <ListState variant="empty">
        No shared agents yet. Promote a workspace agent to the organization to
        share it across workspaces.
      </ListState>
    );
  }

  return (
    <>
      <ul className="grid grid-cols-1 lg:grid-cols-2 gap-2 lg:gap-4">
        {agents.map((agent) => (
          <li key={agent.id}>
            <Item variant="outline" className="h-full">
              {agent.avatarUrl ? (
                <ItemMedia variant="image" className="size-12 rounded-lg">
                  {/* Agent avatar URL is user-supplied (arbitrary host); not
                  routable through the Next image optimizer. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={agent.avatarUrl}
                    alt={agent.name}
                    className="size-full object-cover"
                  />
                </ItemMedia>
              ) : (
                <ItemMedia
                  variant="icon"
                  className="size-12 rounded-lg [&_svg]:!size-7"
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
              </ItemContent>
              {canManage && (
                <ItemActions>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        className="cursor-pointer text-muted-foreground"
                        variant="ghost"
                        size="icon"
                      >
                        <EllipsisVertical className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent>
                      <DropdownMenuItem asChild>
                        <Link
                          className="cursor-pointer"
                          href={`/${orgId}/settings/agents/${agent.id}`}
                        >
                          <Pencil /> Edit
                        </Link>
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        className="cursor-pointer"
                        onSelect={() => setAgentToManage(agent)}
                      >
                        <Share2 /> Manage attachments
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        className="cursor-pointer text-destructive focus:text-destructive"
                        onSelect={() => deleteGuard.request(agent)}
                      >
                        <Trash2 /> Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </ItemActions>
              )}
            </Item>
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
