"use client";

import useSWR from "swr";
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
import { cn, fetcher, joinUrl } from "@/lib/utils";
import { useBackendUrl } from "@/app/client-context";

type ResourceType = "mcp" | "provider" | "skill" | "agent";

const LABEL: Record<ResourceType, string> = {
  mcp: "MCP server",
  provider: "provider",
  skill: "skill",
  agent: "agent",
};

type AttachedWorkspace = { workspaceId: string; workspaceName: string };

const attachmentsUrl = (
  backendUrl: string,
  orgId: string,
  resourceType: ResourceType,
  resourceId: string,
) =>
  joinUrl(
    backendUrl,
    `/organizations/${orgId}/attachments?resourceType=${resourceType}&resourceId=${resourceId}`,
  );

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
  const backendUrl = useBackendUrl();
  const { data } = useSWR<{ results: AttachedWorkspace[] }>(
    backendUrl
      ? attachmentsUrl(backendUrl, orgId, resourceType, resourceId)
      : null,
    fetcher,
  );
  const attached = data?.results ?? [];
  const count = attached.length;

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

  const { data: attData, mutate: mutateAtt } = useSWR<{
    results: AttachedWorkspace[];
  }>(
    backendUrl
      ? attachmentsUrl(backendUrl, orgId, resourceType, resourceId)
      : null,
    fetcher,
  );
  const attached = attData?.results ?? [];
  const attachedIds = new Set(attached.map((a) => a.workspaceId));

  // The full workspace list is only needed while the dialog is open.
  const { data: wsData } = useSWR<{ results: { id: string; name: string }[] }>(
    open && backendUrl
      ? joinUrl(backendUrl, `/organizations/${orgId}/workspaces`)
      : null,
    fetcher,
  );
  const workspaces = [...(wsData?.results ?? [])].sort((a, b) =>
    a.name.localeCompare(b.name),
  );

  const toggle = async (workspaceId: string, isAttached: boolean) => {
    if (!backendUrl) return;
    setBusyId(workspaceId);
    try {
      if (isAttached) {
        await fetch(
          joinUrl(
            backendUrl,
            `/organizations/${orgId}/attachments/${resourceType}/${resourceId}/${workspaceId}`,
          ),
          { method: "DELETE", credentials: "include" },
        );
      } else {
        await fetch(
          joinUrl(backendUrl, `/organizations/${orgId}/attachments`),
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({ resourceType, resourceId, workspaceId }),
          },
        );
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
            Choose which workspaces this {LABEL[resourceType]} appears in. It
            runs against each workspace&apos;s own resources.
          </DialogDescription>
        </DialogHeader>

        {/* Currently-attached workspaces as removable chips. */}
        {count > 0 ? (
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
            <CommandEmpty>No workspaces found.</CommandEmpty>
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
