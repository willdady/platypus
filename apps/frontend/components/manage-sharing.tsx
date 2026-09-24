"use client";

import { Check, FolderClosed, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useState } from "react";
import { cn, joinUrl } from "@/lib/utils";
import { attachmentsEntity, writeAt } from "@/lib/api-write";
import { useScopedSWR } from "@/hooks/use-scoped-swr";
import { useBackendUrl } from "@/components/auth-provider";
import { Skeleton } from "@/components/ui/skeleton";

type ResourceType = "mcp" | "provider" | "skill" | "agent";

const LABEL: Record<ResourceType, string> = {
  mcp: "MCP server",
  provider: "provider",
  skill: "skill",
  agent: "agent",
};

type AttachedWorkspace = { workspaceId: string; workspaceName: string };

/**
 * Read-only affordance shown on an org-surface card: "Shared with N workspaces"
 * with a hover tooltip listing the workspaces (ADR-0007). Mirrors the
 * tool-set/skill hover summaries on the workspace home page. Managing the
 * attachments themselves happens via {@link ManageAttachmentsDialog}.
 */
export const SharedWithBadge = ({
  orgId,
  resourceType,
  resourceId,
}: {
  orgId: string;
  resourceType: ResourceType;
  resourceId: string;
}) => {
  const { data, isLoading } = useScopedSWR<{ results: AttachedWorkspace[] }>(
    attachmentsEntity(resourceType, resourceId),
    { orgId },
  );
  const attached = data?.results ?? [];
  const count = attached.length;

  // Sized to the loaded badge (icon + "N workspaces" at text-xs), so a count
  // doesn't read as "0" before the read resolves.
  if (isLoading) {
    return (
      <Skeleton className="h-4 w-20" aria-label="Loading shared workspaces" />
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger
        className="flex items-center gap-1 cursor-default text-xs text-muted-foreground"
        onClick={(e) => e.preventDefault()}
      >
        <FolderClosed className="size-3" />
        {count} workspace{count !== 1 && "s"}
      </TooltipTrigger>
      {count > 0 && (
        <TooltipContent>
          <ul className="text-left">
            {attached.map((a) => (
              <li key={a.workspaceId}>{a.workspaceName}</li>
            ))}
          </ul>
        </TooltipContent>
      )}
    </Tooltip>
  );
};

/**
 * Org Admin dialog to manage where a Shared resource is attached (ADR-0007).
 * A searchable multi-select that scales to many workspaces: attached
 * workspaces show as removable chips and the list filters as you type.
 * Controlled by the caller (opened from the card's "Manage attachments" menu).
 */
export const ManageAttachmentsDialog = ({
  orgId,
  resourceType,
  resourceId,
  resourceName,
  open,
  onOpenChange,
}: {
  orgId: string;
  resourceType: ResourceType;
  resourceId: string;
  resourceName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) => {
  const backendUrl = useBackendUrl();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const {
    data: attData,
    isLoading: attLoading,
    mutate: mutateAtt,
  } = useScopedSWR<{
    results: AttachedWorkspace[];
  }>(attachmentsEntity(resourceType, resourceId), { orgId });
  const attached = attData?.results ?? [];
  const attachedIds = new Set(attached.map((a) => a.workspaceId));

  // The full workspace list is only needed while the dialog is open.
  const { data: wsData, isLoading: wsLoading } = useScopedSWR<{
    results: { id: string; name: string }[];
  }>("workspaces", open ? { orgId } : null);
  const workspaces = [...(wsData?.results ?? [])].sort((a, b) =>
    a.name.localeCompare(b.name),
  );

  const toggle = async (workspaceId: string, isAttached: boolean) => {
    if (!backendUrl) return;
    setBusyId(workspaceId);
    setError(null);
    try {
      const outcome = isAttached
        ? await writeAt(
            joinUrl(
              backendUrl,
              `/organizations/${orgId}/attachments/${resourceType}/${resourceId}/${workspaceId}`,
            ),
            { method: "DELETE" },
          )
        : await writeAt(
            joinUrl(backendUrl, `/organizations/${orgId}/attachments`),
            { method: "POST", data: { resourceType, resourceId, workspaceId } },
          );
      if (outcome.outcome !== "success") {
        setError(outcome.message);
        return;
      }
      await mutateAtt();
    } finally {
      setBusyId(null);
    }
  };

  const count = attached.length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Share “{resourceName}”</DialogTitle>
          <DialogDescription>
            {/* Keep the apostrophe literal, not `&apos;` — see
                jsx-entity-whitespace.test.ts. */}
            Choose which workspaces this {LABEL[resourceType]} appears in. It
            runs against each workspace’s own resources.
          </DialogDescription>
        </DialogHeader>

        {error && <p className="text-sm text-destructive">{error}</p>}

        {/* Currently-attached workspaces as removable chips. */}
        {attLoading ? (
          <div
            className="flex flex-wrap gap-1"
            aria-label="Loading attachments"
          >
            <Skeleton className="h-[22px] w-24 rounded-full" />
            <Skeleton className="h-[22px] w-20 rounded-full" />
          </div>
        ) : count > 0 ? (
          <div className="flex flex-wrap gap-1">
            {attached.map((a) => (
              <Badge key={a.workspaceId} variant="secondary" className="gap-1">
                {a.workspaceName}
                <button
                  type="button"
                  aria-label={`Detach ${a.workspaceName}`}
                  disabled={busyId === a.workspaceId}
                  onClick={() => toggle(a.workspaceId, true)}
                  className="cursor-pointer rounded-sm hover:text-destructive disabled:opacity-50"
                >
                  <X className="size-3" />
                </button>
              </Badge>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Not shared with any workspace yet.
          </p>
        )}

        {/* Searchable multi-select — scales to many workspaces. */}
        <Command>
          <CommandInput placeholder="Search workspaces…" />
          <CommandList>
            {/* Rows in place of the false "No workspaces found." while the
                list is still loading. */}
            {wsLoading ? (
              <div className="p-1" aria-label="Loading workspaces">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="flex items-center gap-2 px-2 py-1.5">
                    <Skeleton className="mr-2 size-4" />
                    <Skeleton className="h-4 w-32" />
                  </div>
                ))}
              </div>
            ) : (
              <CommandEmpty>No workspaces found.</CommandEmpty>
            )}
            <CommandGroup>
              {workspaces.map((ws) => {
                const isAtt = attachedIds.has(ws.id);
                return (
                  <CommandItem
                    key={ws.id}
                    // Include the id so the search value stays unique even if
                    // two workspaces share a name; search still matches name.
                    value={`${ws.name} ${ws.id}`}
                    disabled={busyId === ws.id}
                    onSelect={() => toggle(ws.id, isAtt)}
                  >
                    <Check
                      className={cn(
                        "mr-2 size-4",
                        isAtt ? "opacity-100" : "opacity-0",
                      )}
                    />
                    {ws.name}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
