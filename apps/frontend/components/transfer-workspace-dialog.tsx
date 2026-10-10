"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useSWRConfig } from "swr";
import { toast } from "sonner";
import { ArrowRightLeft } from "lucide-react";
import {
  type OrgMemberListItem,
  type Provider,
  type Workspace,
} from "@platypus/schemas";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { FieldGroup } from "@/components/ui/field";
import { useBackendUrl } from "@/components/auth-provider";
import { useScopedSWR } from "@/hooks/use-scoped-swr";
import { scopedUrl, workspaceEntity, writeAt } from "@/lib/api-write";
import {
  NoRecipientHint,
  TransferFields,
  transferRecipients,
} from "@/components/workspace-transfer-fields";

type TransferWorkspaceActionProps = {
  orgId: string;
  workspaceId: string;
  /** The Providers visible in the Workspace; its own are listed for review. */
  providers: Provider[];
};

/**
 * The Org Admin's Transfer action on a Workspace's settings (ADR-0035): a
 * button beside Delete, disabled with an invite hint when nobody can receive
 * the Workspace, and the dialog that picks a recipient and the history, then
 * confirms what the transfer does.
 */
export const TransferWorkspaceAction = ({
  orgId,
  workspaceId,
  providers,
}: TransferWorkspaceActionProps) => {
  const backendUrl = useBackendUrl();
  const router = useRouter();
  const { mutate } = useSWRConfig();
  const { data: workspace } = useScopedSWR<Workspace>(
    workspaceEntity(workspaceId),
    { orgId },
  );
  const { data: membersData } = useScopedSWR<{
    results: OrgMemberListItem[];
  }>("members", { orgId });

  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<"choose" | "confirm">("choose");
  const [newOwnerId, setNewOwnerId] = useState("");
  const [keepHistory, setKeepHistory] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);

  if (!workspace || !membersData) return null;
  const members = membersData.results;
  const recipients = transferRecipients(members, workspace.ownerId);
  const nameOf = (userId: string) =>
    members.find((m) => m.userId === userId)?.user.name ?? "The current owner";
  const ownProviders = providers.filter((p) => p.workspaceId === workspaceId);

  const openDialog = () => {
    setStep("choose");
    setNewOwnerId("");
    setKeepHistory(true);
    setOpen(true);
  };

  const handleTransfer = async () => {
    setIsSubmitting(true);
    try {
      const url = scopedUrl(backendUrl, workspaceEntity(workspaceId), {
        orgId,
      });
      const outcome = await writeAt(`${url}/transfer`, {
        method: "POST",
        data: { newOwnerId, keepHistory },
        revalidateKeys: [url, scopedUrl(backendUrl, "workspaces", { orgId })],
      });
      if (outcome.outcome === "success") {
        outcome.revalidateKeys.forEach((key) => mutate(key));
        toast.success("Workspace transferred");
        setOpen(false);
        router.refresh();
      } else {
        toast.error(outcome.message);
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <>
      <div className="flex flex-col items-start gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={openDialog}
          disabled={recipients.length === 0}
        >
          <ArrowRightLeft /> Transfer
        </Button>
        {recipients.length === 0 && <NoRecipientHint orgId={orgId} />}
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Transfer Workspace</DialogTitle>
            <DialogDescription>
              {step === "choose"
                ? `Make another member the owner of ${workspace.name}.`
                : `Transfer ${workspace.name} to ${nameOf(newOwnerId)}?`}
            </DialogDescription>
          </DialogHeader>

          {step === "choose" ? (
            <FieldGroup>
              <TransferFields
                idPrefix="transfer"
                recipients={recipients}
                newOwnerId={newOwnerId}
                keepHistory={keepHistory}
                onChange={(change) => {
                  if (change.newOwnerId !== undefined) {
                    setNewOwnerId(change.newOwnerId);
                  }
                  if (change.keepHistory !== undefined) {
                    setKeepHistory(change.keepHistory);
                  }
                }}
              />
            </FieldGroup>
          ) : (
            <div className="space-y-3 text-sm">
              <ul className="list-disc space-y-1 pl-5">
                <li>
                  {nameOf(newOwnerId)} becomes the owner.{" "}
                  {nameOf(workspace.ownerId)} loses access immediately.
                </li>
                <li>
                  {keepHistory
                    ? `Chats stay, and their Memories move to ${nameOf(newOwnerId)}.`
                    : "Chats, Memories and Notifications are deleted."}{" "}
                  Boards, Cards, Sandbox files and Dashboards are kept.
                </li>
                <li>
                  Every Trigger is switched off, and every Inbound Trigger and
                  A2A token is revoked.
                </li>
                <li>
                  MCP sign-ins and bearer tokens and the sandbox&apos;s owner
                  environment are cleared. Owner-managed providers and MCP
                  servers are switched off.
                </li>
                <li>Running chats, Trigger runs and A2A tasks are stopped.</li>
              </ul>
              {ownProviders.length > 0 && (
                <div>
                  <p>
                    These providers keep their keys. Review them before the new
                    owner uses them:
                  </p>
                  <ul className="list-disc pl-5">
                    {ownProviders.map((p) => (
                      <li key={p.id}>{p.name}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          <DialogFooter>
            {step === "choose" ? (
              <>
                <Button variant="outline" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
                <Button
                  onClick={() => setStep("confirm")}
                  disabled={!newOwnerId}
                >
                  Next
                </Button>
              </>
            ) : (
              <>
                <Button
                  variant="outline"
                  onClick={() => setStep("choose")}
                  disabled={isSubmitting}
                >
                  Back
                </Button>
                <Button onClick={handleTransfer} disabled={isSubmitting}>
                  {isSubmitting ? "Transferring..." : "Transfer"}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};
