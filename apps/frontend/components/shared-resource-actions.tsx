"use client";

import { useState } from "react";
import Link from "next/link";
import { ExternalLink, Link2, Unlink } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { AttachSharedResourceDialog } from "@/components/attach-shared-resource-dialog";
import type {
  DeleteGuard,
  NamedResource,
  PromoteBlocker,
  PromoteFlow,
} from "@/hooks/use-shared-resource-actions";
import type { DeleteFlow } from "@/hooks/use-delete-flow";
import type { AttachmentResourceType } from "@platypus/schemas";

export function AttachSharedAction<
  T extends { readonly id: string; readonly scope?: string },
>({
  orgId,
  workspaceId,
  resourceType,
  label,
  resources,
  onAttached,
}: {
  orgId: string;
  workspaceId: string;
  resourceType: AttachmentResourceType;
  label: string;
  resources: readonly T[];
  onAttached: () => void;
}) {
  const [open, setOpen] = useState(false);
  const attachedIds = resources
    .filter((resource) => resource.scope === "organization")
    .map((resource) => resource.id);

  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <Link2 /> {label}
      </Button>
      <AttachSharedResourceDialog
        open={open}
        onOpenChange={setOpen}
        orgId={orgId}
        workspaceId={workspaceId}
        resourceType={resourceType}
        attachedIds={attachedIds}
        onAttached={() => {
          setOpen(false);
          onAttached();
        }}
      />
    </>
  );
}

export function DetachSharedDialog<T extends NamedResource>({
  detach,
  noun,
  canDetach,
  orgSettingsHref,
}: {
  detach: DeleteFlow<T>;
  noun: string;
  canDetach: boolean;
  orgSettingsHref: (target: T) => string;
}) {
  return (
    <Dialog
      open={detach.open}
      onOpenChange={(open) => {
        if (!open) detach.close();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Detach shared {noun}</DialogTitle>
          <DialogDescription>
            {detach.target && (
              <>
                Detach <strong>{detach.target.name}</strong> from this
                workspace? The shared {noun} itself is not deleted; it just
                stops appearing here.
              </>
            )}
          </DialogDescription>
        </DialogHeader>
        {detach.error && (
          <p role="alert" className="text-sm text-destructive">
            {detach.error}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={detach.close}>
            Close
          </Button>
          {canDetach && detach.target && (
            <Button
              variant="destructive"
              disabled={detach.deleting}
              onClick={detach.confirm}
            >
              <Unlink />
              Detach
            </Button>
          )}
          {canDetach && detach.target && (
            <Button asChild>
              <Link href={orgSettingsHref(detach.target)}>
                <ExternalLink />
                Org settings
              </Link>
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const BLOCKER_LABEL: Record<PromoteBlocker["type"], string> = {
  provider: "Provider",
  skill: "Skill",
  subAgent: "Sub-Agent",
  mcp: "MCP tool set",
};

export function PromoteSharedDialog<T extends NamedResource>({
  promote,
  noun,
}: {
  promote: PromoteFlow<T>;
  noun: string;
}) {
  return (
    <Dialog
      open={!!promote.selected}
      onOpenChange={(open) => {
        if (!open) promote.close();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Promote to organization</DialogTitle>
          <DialogDescription>
            Promote <strong>{promote.selected?.name}</strong> to an
            organization-shared {noun}? It will be managed by org admins and
            remain attached to this workspace.
          </DialogDescription>
        </DialogHeader>
        {promote.blockers.length > 0 && (
          <div className="rounded-md border border-warning bg-warning/10 p-3 text-sm">
            <p className="mb-2 font-medium">
              Promote the following workspace-private references first:
            </p>
            <ul className="flex flex-col gap-1">
              {promote.blockers.map((b) => (
                <li key={`${b.type}-${b.id}`} className="flex gap-2">
                  <span className="text-muted-foreground">
                    {BLOCKER_LABEL[b.type]}:
                  </span>
                  <span className="font-medium">{b.name}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {promote.error && promote.blockers.length === 0 && (
          <p role="alert" className="text-sm text-destructive">
            {promote.error}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={promote.close}>
            Cancel
          </Button>
          <Button onClick={promote.confirm} disabled={promote.promoting}>
            Promote
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function DeleteBlockedDialog<T extends NamedResource>({
  guard,
  noun,
  onManage,
}: {
  guard: DeleteGuard<T>;
  noun: string;
  onManage: (item: T) => void;
}) {
  return (
    <ConfirmDialog
      open={!!guard.blocked}
      onOpenChange={(open) => !open && guard.clear()}
      title={`Can't delete shared ${noun}`}
      description={
        guard.blocked
          ? `“${guard.blocked.item.name}” is shared with ${guard.blocked.count} workspace${
              guard.blocked.count !== 1 ? "s" : ""
            }. Detach it from every workspace before deleting.`
          : ""
      }
      confirmLabel="Manage attachments"
      cancelLabel="Close"
      onConfirm={() => {
        const item = guard.blocked?.item;
        guard.clear();
        if (item) onManage(item);
      }}
    />
  );
}
