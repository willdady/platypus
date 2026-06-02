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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Bot, EllipsisVertical, Pencil, Share2, Trash2 } from "lucide-react";
import { type Agent } from "@platypus/schemas";
import useSWR from "swr";
import { fetcher, joinUrl } from "@/lib/utils";
import { useBackendUrl } from "@/app/client-context";
import { useAuth } from "@/components/auth-provider";
import {
  ManageAttachmentsDialog,
  SharedWithBadge,
} from "@/components/manage-sharing";
import Link from "next/link";

// The Organization surface for Shared Agents (ADR-0007): Org Admins see and
// manage every Shared Agent, attached or not. Promotion (from a Workspace) is
// the way a Shared Agent is created; it is then edited, shared, and deleted
// here on the Organization surface — in Workspaces it is locked.
export const OrgAgentsList = ({ orgId }: { orgId: string }) => {
  const { user, isOrgAdmin } = useAuth();
  const backendUrl = useBackendUrl();
  const [agentToDelete, setAgentToDelete] = useState<Agent | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [agentToManage, setAgentToManage] = useState<Agent | null>(null);
  const [deleteBlocked, setDeleteBlocked] = useState<{
    agent: Agent;
    count: number;
  } | null>(null);

  const { data, isLoading, mutate } = useSWR<{ results: Agent[] }>(
    backendUrl && user
      ? joinUrl(backendUrl, `/organizations/${orgId}/agents`)
      : null,
    fetcher,
  );

  const agents = [...(data?.results || [])].sort((a, b) =>
    a.name.localeCompare(b.name),
  );

  // A Shared resource can't be deleted while attached (ADR-0007). Check the
  // live attachment count first so we explain the blocker up front instead of
  // offering a Delete button that is guaranteed to fail.
  const requestDelete = async (agent: Agent) => {
    if (!backendUrl) return;
    try {
      const res = await fetch(
        joinUrl(
          backendUrl,
          `/organizations/${orgId}/attachments?resourceType=agent&resourceId=${agent.id}`,
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
    setDeleteError(null);
    setAgentToDelete(agent);
  };

  const handleDeleteConfirm = async () => {
    if (!agentToDelete || !backendUrl) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      const response = await fetch(
        joinUrl(
          backendUrl,
          `/organizations/${orgId}/agents/${agentToDelete.id}`,
        ),
        { method: "DELETE", credentials: "include" },
      );
      if (response.ok) {
        await mutate();
        setAgentToDelete(null);
      } else {
        const info = await response.json().catch(() => ({}));
        setDeleteError(info.error || "Failed to delete agent.");
      }
    } finally {
      setDeleting(false);
    }
  };

  if (isLoading) {
    return <div>Loading...</div>;
  }

  if (agents.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No shared agents yet. Promote a workspace agent to the organization to
        share it across workspaces.
      </p>
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
                {isOrgAdmin && (
                  <div className="mt-1">
                    <SharedWithBadge
                      orgId={orgId}
                      resourceType="agent"
                      resourceId={agent.id}
                    />
                  </div>
                )}
              </ItemContent>
              {isOrgAdmin && (
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

      <ConfirmDialog
        open={!!agentToDelete}
        onOpenChange={(open) => {
          if (!open) {
            setAgentToDelete(null);
            setDeleteError(null);
          }
        }}
        title="Delete shared agent"
        description={`Delete "${agentToDelete?.name}"? This cannot be undone.`}
        confirmLabel="Delete"
        confirmVariant="destructive"
        onConfirm={handleDeleteConfirm}
        loading={deleting}
        error={deleteError}
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
