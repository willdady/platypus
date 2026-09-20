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
import { ConfirmDialog } from "@/components/confirm-dialog";
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
import { joinUrl } from "@/lib/utils";
import { useScopedSWR } from "@/hooks/use-scoped-swr";
import { useAuth, useBackendUrl } from "@/components/auth-provider";
import { canManageOrgSharedResource } from "@/lib/authorization";
import {
  ManageAttachmentsDialog,
  SharedWithBadge,
} from "@/components/manage-sharing";
import Link from "next/link";
import { scopedPath, writeEntity, type Scope } from "@/lib/api-write";
import { useDeleteFlow } from "@/hooks/use-delete-flow";
import { orgRoutes } from "@/lib/routes";

// The Organization surface for Shared Agents (ADR-0007): Org Admins see and
// manage every Shared Agent, attached or not. Promotion (from a Workspace) is
// the way a Shared Agent is created; it is then edited, shared, and deleted
// here on the Organization surface — in Workspaces it is locked.
export const OrgAgentsList = ({ orgId }: { orgId: string }) => {
  const { actor } = useAuth();
  const canManage = canManageOrgSharedResource(actor).allowed;
  const backendUrl = useBackendUrl();
  const [agentToManage, setAgentToManage] = useState<Agent | null>(null);
  const [deleteBlocked, setDeleteBlocked] = useState<{
    agent: Agent;
    count: number;
  } | null>(null);

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

  // A Shared resource can't be deleted while attached (ADR-0007). Check the
  // live attachment count first so we explain the blocker up front instead of
  // offering a Delete button that is guaranteed to fail.
  const requestDelete = async (agent: Agent) => {
    if (!backendUrl) return;
    try {
      const res = await fetch(
        joinUrl(
          backendUrl,
          `${scopedPath("attachments", scope)}?resourceType=agent&resourceId=${agent.id}`,
        ),
        { credentials: "include" },
      );
      const info = await res.json().catch(() => ({ results: [] }));
      const count = (info.results ?? []).length;
      if (count > 0) {
        setDeleteBlocked({ agent, count });
        return;
      }
    } catch {
      // If the check fails, fall through — the backend still guards with a 409.
    }
    deleteFlow.request(agent);
  };

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
                          href={orgRoutes(orgId).settings.agentDetail(agent.id)}
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
                        onSelect={() => requestDelete(agent)}
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

      <ConfirmDialog
        open={!!deleteBlocked}
        onOpenChange={(open) => !open && setDeleteBlocked(null)}
        title="Can't delete shared agent"
        description={
          deleteBlocked
            ? `“${deleteBlocked.agent.name}” is shared with ${deleteBlocked.count} workspace${
                deleteBlocked.count !== 1 ? "s" : ""
              }. Detach it from every workspace before deleting.`
            : ""
        }
        confirmLabel="Manage attachments"
        cancelLabel="Close"
        onConfirm={() => {
          const agent = deleteBlocked?.agent ?? null;
          setDeleteBlocked(null);
          setAgentToManage(agent);
        }}
      />
    </>
  );
};
