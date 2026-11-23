"use client";

import Link from "next/link";
import { type OrgMemberListItem } from "@platypus/schemas";
import { SelectItem } from "@/components/ui/select";
import { FormSelectField } from "@/components/form-select-field";
import { FormSwitchField } from "@/components/form-switch-field";
import { orgRoutes } from "@/lib/routes";
import type { Serialized } from "@/lib/api-write";

/**
 * Who may receive a Workspace transfer (ADR-0035): any member of the
 * Organization who is not banned and does not already own it.
 */
export function transferRecipients(
  members: Serialized<OrgMemberListItem>[],
  ownerId: string,
): Serialized<OrgMemberListItem>[] {
  return members.filter((m) => m.userId !== ownerId && !m.isBanned);
}

/** What a transfer does with the Workspace's history, for either choice. */
export function historyOutcome(keepHistory: boolean, newOwner: string) {
  return keepHistory
    ? `Chats stay, and their Memories move to ${newOwner}.`
    : "Chats, Memories and Notifications are deleted.";
}

/** Shown in place of a transfer when nobody can receive one. */
export function NoRecipientHint({ orgId }: { orgId: string }) {
  return (
    <p className="text-sm text-muted-foreground">
      No other member can receive a transfer.{" "}
      <Link href={orgRoutes(orgId).settings.invitations} className="underline">
        Invite someone
      </Link>{" "}
      to the organization first.
    </p>
  );
}

type TransferFieldsProps = {
  /** Prefixes the field ids, so several sets can share a page. */
  idPrefix: string;
  recipients: Serialized<OrgMemberListItem>[];
  newOwnerId: string;
  keepHistory: boolean;
  onChange: (change: { newOwnerId?: string; keepHistory?: boolean }) => void;
  disabled?: boolean;
  /** A server rejection mapped to the owner field, shown under the picker. */
  error?: string;
};

/** The two choices a transfer takes: the new Owner, and the history. */
export function TransferFields({
  idPrefix,
  recipients,
  newOwnerId,
  keepHistory,
  onChange,
  disabled,
  error,
}: TransferFieldsProps) {
  return (
    <>
      <FormSelectField
        label="New owner"
        name={`${idPrefix}-newOwnerId`}
        value={newOwnerId}
        onValueChange={(value) => onChange({ newOwnerId: value })}
        placeholder="Select a member"
        error={error}
        disabled={disabled}
      >
        {recipients.map((m) => (
          <SelectItem key={m.userId} value={m.userId}>
            {m.user.name} ({m.user.email})
          </SelectItem>
        ))}
      </FormSelectField>
      <FormSwitchField
        align="end"
        name={`${idPrefix}-keepHistory`}
        label="Keep history"
        description={historyOutcome(keepHistory, "the new owner")}
        checked={keepHistory}
        onCheckedChange={(checked) => onChange({ keepHistory: checked })}
        disabled={disabled}
      />
    </>
  );
}
