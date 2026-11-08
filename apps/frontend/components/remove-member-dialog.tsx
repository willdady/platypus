"use client";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useState } from "react";
import { useSWRConfig } from "swr";
import {
  type MemberWorkspaceDecision,
  type OrgMemberListItem,
  type Workspace,
} from "@platypus/schemas";
import { useBackendUrl } from "@/components/auth-provider";
import { useScopedList } from "@/hooks/use-scoped-list";
import { useMutation } from "@/hooks/use-mutation";
import { ListError } from "@/components/list-state";
import { scopedUrl, writeAt, type Serialized } from "@/lib/api-write";
import {
  NoRecipientHint,
  TransferFields,
  transferRecipients,
} from "@/components/workspace-transfer-fields";
import { toast } from "sonner";
import { AlertTriangle } from "lucide-react";

type RemoveMemberDialogProps = {
  orgId: string;
  member: Serialized<OrgMemberListItem>;
  /** The Organization's members, from which a transfer's recipient is picked. */
  members: Serialized<OrgMemberListItem>[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
};

/** One Workspace's choice while it is being made. */
type Draft = {
  action?: "transfer" | "delete";
  newOwnerId: string;
  keepHistory: boolean;
};

const EMPTY_DRAFT: Draft = { newOwnerId: "", keepHistory: true };

/** The decision a draft makes, or undefined while it is incomplete. */
function decisionOf(
  workspaceId: string,
  draft: Draft,
): MemberWorkspaceDecision | undefined {
  if (draft.action === "delete") return { workspaceId, action: "delete" };
  if (draft.action === "transfer" && draft.newOwnerId) {
    return {
      workspaceId,
      action: "transfer",
      newOwnerId: draft.newOwnerId,
      keepHistory: draft.keepHistory,
    };
  }
  return undefined;
}

/**
 * Remove from Org (ADR-0035). Each Workspace the member owns needs Transfer
 * or Delete before the removal can go ahead; the backend applies them and the
 * removal together, or none of them.
 */
export function RemoveMemberDialog({
  orgId,
  member,
  members,
  open,
  onOpenChange,
  onSuccess,
}: RemoveMemberDialogProps) {
  const backendUrl = useBackendUrl();
  const { mutate } = useSWRConfig();
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});

  // An Org Admin's list holds every Workspace in the Organization.
  const {
    data: workspacesData,
    results: workspaces,
    error: workspacesError,
    mutate: retryWorkspaces,
  } = useScopedList<Workspace>("workspaces", { orgId });
  const owned = workspaces.filter((w) => w.ownerId === member.userId);
  const recipients = transferRecipients(members, member.userId);
  const draftOf = (id: string) => drafts[id] ?? EMPTY_DRAFT;
  const decisions = owned.map((w) => decisionOf(w.id, draftOf(w.id)));
  const complete = decisions.every((d) => d !== undefined);

  const update = (workspaceId: string, change: Partial<Draft>) =>
    setDrafts((prev) => ({
      ...prev,
      [workspaceId]: { ...(prev[workspaceId] ?? EMPTY_DRAFT), ...change },
    }));

  const applyToAll = () => {
    const first = draftOf(owned[0].id);
    setDrafts(Object.fromEntries(owned.map((w) => [w.id, first])));
  };

  const { run: handleSubmit, pending } = useMutation(async () => {
    setDeleteError(null);
    const membersUrl = scopedUrl(backendUrl, "members", { orgId });
    const outcome = await writeAt(`${membersUrl}/${member.id}`, {
      method: "DELETE",
      data: { workspaces: decisions },
      revalidateKeys: [
        membersUrl,
        scopedUrl(backendUrl, "workspaces", { orgId }),
      ],
    });
    if (outcome.outcome === "success") {
      outcome.revalidateKeys.forEach((key) => void mutate(key));
      toast.success("Member removed from organization");
      onSuccess();
    } else {
      // A refused removal stays in the open dialog, so the message can be
      // read and retried rather than toasted and lost.
      setDeleteError(outcome.message);
    }
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setDeleteError(null);
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-destructive">
            <AlertTriangle className="size-5" />
            Remove Member
          </DialogTitle>
          <DialogDescription>
            Remove <strong>{member.user.name}</strong> from this organization?
            They lose access immediately.
          </DialogDescription>
        </DialogHeader>

        {workspacesError ? (
          <ListError
            error={workspacesError}
            subject="workspaces"
            onRetry={() => void retryWorkspaces()}
          />
        ) : (
          owned.length > 0 && (
            <div className="flex flex-col gap-4">
              <p className="text-sm text-muted-foreground">
                They own{" "}
                {owned.length === 1 ? "a workspace" : "these workspaces"} here.
                Transfer each one to another member, or delete it. A transfer
                switches off its Triggers, revokes its tokens and clears its
                sign-ins; its Boards and Sandbox files are kept.
              </p>
              {recipients.length === 0 && <NoRecipientHint orgId={orgId} />}
              {owned.map((w) => {
                const draft = draftOf(w.id);
                return (
                  <FieldGroup key={w.id} className="rounded-md border p-3">
                    <Field>
                      <FieldLabel htmlFor={`action-${w.id}`}>
                        {w.name}
                      </FieldLabel>
                      <Select
                        value={draft.action ?? ""}
                        onValueChange={(value) =>
                          update(w.id, { action: value as Draft["action"] })
                        }
                        disabled={pending}
                      >
                        <SelectTrigger
                          id={`action-${w.id}`}
                          aria-label={`Action for ${w.name}`}
                        >
                          <SelectValue placeholder="Choose what happens" />
                        </SelectTrigger>
                        <SelectContent>
                          {recipients.length > 0 && (
                            <SelectItem value="transfer">Transfer</SelectItem>
                          )}
                          <SelectItem value="delete">Delete</SelectItem>
                        </SelectContent>
                      </Select>
                    </Field>
                    {draft.action === "transfer" && (
                      <TransferFields
                        idPrefix={w.id}
                        recipients={recipients}
                        newOwnerId={draft.newOwnerId}
                        keepHistory={draft.keepHistory}
                        onChange={(change) => update(w.id, change)}
                        disabled={pending}
                      />
                    )}
                  </FieldGroup>
                );
              })}
              {owned.length > 1 && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={applyToAll}
                  className="self-start"
                  disabled={pending || !draftOf(owned[0].id).action}
                >
                  Apply to all
                </Button>
              )}
            </div>
          )
        )}

        {deleteError && (
          <Alert variant="destructive">
            <AlertDescription>{deleteError}</AlertDescription>
          </Alert>
        )}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={handleSubmit}
            disabled={
              pending || !workspacesData || !!workspacesError || !complete
            }
          >
            {pending ? "Removing..." : "Remove"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
