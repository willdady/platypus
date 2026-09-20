"use client";

import { useState, type ReactNode } from "react";
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
  SharedDetach,
  SharedResourceType,
} from "@/hooks/use-shared-resource-actions";

/**
 * The attach half of the Shared-resource actions (#880): the CTA, the picker
 * dialog, and the "which org rows are already here" derivation the agents,
 * skills, MCP, and providers lists each carried separately. The caller passes
 * its own rows; anything scoped to the organization is already attached.
 */
export const AttachSharedAction = <
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
  resourceType: SharedResourceType;
  /** Attach CTA: "Attach shared skill" / "Attach shared MCP". */
  label: string;
  resources: readonly T[];
  onAttached: () => void;
}) => {
  const [open, setOpen] = useState(false);
  const attachedIds = resources
    .filter((resource) => resource.scope === "organization")
    .map((resource) => resource.id);

  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <Link2 className="size-4" /> {label}
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
};

/**
 * The dialog a locked org-scoped row opens in a Workspace: it explains where
 * the resource is managed and offers Detach plus a link to the organization
 * settings. Only the copy and the settings link differ per resource.
 */
export const DetachSharedDialog = <T extends NamedResource>({
  detach,
  title,
  description,
  canDetach,
  orgSettingsHref,
}: {
  detach: SharedDetach<T>;
  title: string;
  description: (selected: T) => ReactNode;
  canDetach: boolean;
  /** Where the Shared resource is actually edited. */
  orgSettingsHref: (selected: T) => string;
}) => (
  <Dialog
    open={!!detach.selected}
    onOpenChange={(open) => {
      if (!open) detach.close();
    }}
  >
    <DialogContent>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>
          {detach.selected && description(detach.selected)}
        </DialogDescription>
      </DialogHeader>
      {detach.error && (
        <p className="text-sm text-destructive">{detach.error}</p>
      )}
      <DialogFooter>
        <Button variant="outline" onClick={detach.close}>
          Close
        </Button>
        {canDetach && detach.selected && (
          <Button
            variant="destructive"
            disabled={detach.detaching}
            onClick={detach.detach}
          >
            <Unlink className="size-4" />
            Detach
          </Button>
        )}
        {canDetach && detach.selected && (
          <Button asChild>
            {/* The Org settings copy, even from a workspace: that is where the
                Shared resource is edited. */}
            <Link href={orgSettingsHref(detach.selected)}>
              <ExternalLink className="size-4" />
              Org settings
            </Link>
          </Button>
        )}
      </DialogFooter>
    </DialogContent>
  </Dialog>
);

const BLOCKER_LABEL: Record<PromoteBlocker["type"], string> = {
  provider: "Provider",
  skill: "Skill",
  subAgent: "Sub-Agent",
  mcp: "MCP tool set",
};

/**
 * The Promote confirmation. A refused promote may come back with the
 * workspace-private references to fix first (ADR-0007's no-cascade rule);
 * those replace the plain error message when present.
 */
export const PromoteSharedDialog = <T extends NamedResource>({
  promote,
  noun,
}: {
  promote: PromoteFlow<T>;
  /** The resource named mid-sentence: "agent" / "skill". */
  noun: string;
}) => (
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
          <ul className="space-y-1">
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
        <p className="text-sm text-destructive">{promote.error}</p>
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

/**
 * What the Organization surface shows instead of a delete it knows will fail:
 * the attachment count, and a way through to the attachments dialog.
 */
export const DeleteBlockedDialog = <T extends NamedResource>({
  guard,
  noun,
  onManage,
}: {
  guard: DeleteGuard<T>;
  /** The resource named mid-sentence: "agent" / "skill". */
  noun: string;
  /** Opens the Manage attachments dialog for the blocked row. */
  onManage: (item: T) => void;
}) => (
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
