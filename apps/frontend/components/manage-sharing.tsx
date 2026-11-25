"use client";

import { Check, FolderClosed, TriangleAlert, X } from "lucide-react";
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
import { useState, type ReactNode } from "react";
import { cn, sortByName } from "@/lib/utils";
import {
  attachResource,
  attachmentsEntity,
  detachResource,
} from "@/lib/api-write";
import { ATTACHMENT_RESOURCE_LABELS } from "@/lib/attachment-resource";
import { useScopedList } from "@/hooks/use-scoped-list";
import { useBackendUrl } from "@/components/auth-provider";
import type { NamedResource } from "@/hooks/use-shared-resource-actions";
import { LoadingRegion } from "@/components/list-skeletons";
import { Skeleton } from "@/components/ui/skeleton";
import type { AttachmentResourceType } from "@platypus/schemas";

type AttachedWorkspace = { workspaceId: string; workspaceName: string };

// why: one key per resource, so badge, card warning and dialog revalidate together
function useAttachments(
  orgId: string | null,
  resourceType: AttachmentResourceType,
  resourceId: string,
) {
  return useScopedList<AttachedWorkspace>(
    attachmentsEntity(resourceType, resourceId),
    orgId ? { orgId } : null,
  );
}

function useAttachmentCount(
  orgId: string | null,
  resourceType: AttachmentResourceType,
  resourceId: string,
): number | undefined {
  return useAttachments(orgId, resourceType, resourceId).data?.results.length;
}

// why: render prop, so a list calls the hook per row without a row component
export function AttachmentCount({
  orgId,
  resourceType,
  resourceId,
  children,
}: {
  orgId: string | null;
  resourceType: AttachmentResourceType;
  resourceId: string;
  children: (count: number | undefined) => ReactNode;
}) {
  return children(useAttachmentCount(orgId, resourceType, resourceId));
}

export function UnattachedWarning({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "mt-1 flex items-center gap-1 cursor-default text-xs text-warning-foreground",
        className,
      )}
    >
      <TriangleAlert className="size-3" />
      <strong>WARNING:</strong> Not attached to any workspaces.
    </span>
  );
}

// why: keep the empty line while pending or non-zero, so every card is one height
export function UnattachedWarningLine({
  count,
}: {
  count: number | undefined;
}) {
  return (
    <div
      className="mt-1 h-4 overflow-hidden whitespace-nowrap"
      title={
        count === 0 ? "WARNING: Not attached to any workspaces." : undefined
      }
    >
      {count === 0 && <UnattachedWarning className="mt-0" />}
    </div>
  );
}

export function SharedWithBadge({
  orgId,
  resourceType,
  resourceId,
}: {
  orgId: string;
  resourceType: AttachmentResourceType;
  resourceId: string;
}) {
  const { results: attached, isLoading } = useAttachments(
    orgId,
    resourceType,
    resourceId,
  );
  const count = attached.length;

  // why: skeleton sized to the loaded badge, so a count never reads as 0 first
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
}

export function ManageAttachmentsDialog({
  orgId,
  resourceType,
  resource,
  onClose,
}: {
  orgId: string;
  resourceType: AttachmentResourceType;
  resource: NamedResource | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={!!resource} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        {resource && (
          <ManageAttachmentsContent
            orgId={orgId}
            resourceType={resourceType}
            resource={resource}
            onClose={onClose}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

// why: mounted per resource, so a new row starts with no error or in-flight id
function ManageAttachmentsContent({
  orgId,
  resourceType,
  resource,
  onClose,
}: {
  orgId: string;
  resourceType: AttachmentResourceType;
  resource: NamedResource;
  onClose: () => void;
}) {
  const backendUrl = useBackendUrl();
  const label = ATTACHMENT_RESOURCE_LABELS[resourceType];
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const {
    results: attached,
    isLoading: attLoading,
    mutate: mutateAtt,
  } = useAttachments(orgId, resourceType, resource.id);
  const attachedIds = new Set(attached.map((a) => a.workspaceId));

  const { results: allWorkspaces, isLoading: wsLoading } = useScopedList<{
    id: string;
    name: string;
  }>("workspaces", { orgId });
  const workspaces = sortByName(allWorkspaces);

  const toggle = async (workspaceId: string, isAttached: boolean) => {
    if (!backendUrl) return;
    setBusyId(workspaceId);
    setError(null);
    try {
      const outcome = isAttached
        ? await detachResource(
            backendUrl,
            { orgId, workspaceId },
            resourceType,
            resource.id,
          )
        : await attachResource(
            backendUrl,
            { orgId, workspaceId },
            resourceType,
            resource.id,
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
    <>
      <DialogHeader>
        <DialogTitle>Share “{resource.name}”</DialogTitle>
        <DialogDescription>
          Choose which workspaces this {label} appears in. It runs against each
          workspace’s own resources.
        </DialogDescription>
      </DialogHeader>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      {attLoading ? (
        <LoadingRegion
          label="Loading attachments"
          className="flex flex-wrap gap-1"
        >
          <Skeleton className="h-badge w-24 rounded-full" />
          <Skeleton className="h-badge w-20 rounded-full" />
        </LoadingRegion>
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
                className="rounded-sm hover:text-destructive disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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

      <Command>
        <CommandInput placeholder="Search workspaces..." />
        <CommandList>
          {wsLoading ? (
            <LoadingRegion label="Loading workspaces" className="p-1">
              {[0, 1, 2].map((i) => (
                <div key={i} className="flex items-center gap-2 px-2 py-1.5">
                  <Skeleton className="mr-2 size-4" />
                  <Skeleton className="h-4 w-32" />
                </div>
              ))}
            </LoadingRegion>
          ) : (
            <CommandEmpty>No workspaces found.</CommandEmpty>
          )}
          <CommandGroup>
            {workspaces.map((ws) => {
              // why: append the id so equal-named workspaces stay distinct; search matches name
              const isAtt = attachedIds.has(ws.id);
              return (
                <CommandItem
                  key={ws.id}
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
        <Button variant="outline" onClick={onClose}>
          Done
        </Button>
      </DialogFooter>
    </>
  );
}
