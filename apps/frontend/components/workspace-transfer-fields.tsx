"use client";

import Link from "next/link";
import { type OrgMemberListItem } from "@platypus/schemas";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { orgRoutes } from "@/lib/routes";

/**
 * Who may receive a Workspace transfer (ADR-0035): any member of the
 * Organization who is not banned and does not already own it.
 */
export const transferRecipients = (
  members: OrgMemberListItem[],
  ownerId: string,
): OrgMemberListItem[] =>
  members.filter((m) => m.userId !== ownerId && !m.isBanned);

/** What a transfer does with the Workspace's history, for either choice. */
export const historyOutcome = (keepHistory: boolean, newOwner: string) =>
  keepHistory
    ? `Chats stay, and their Memories move to ${newOwner}.`
    : "Chats, Memories and Notifications are deleted.";

/** Shown in place of a transfer when nobody can receive one. */
export const NoRecipientHint = ({ orgId }: { orgId: string }) => (
  <p className="text-sm text-muted-foreground">
    No other member can receive a transfer.{" "}
    <Link href={orgRoutes(orgId).settings.invitations} className="underline">
      Invite someone
    </Link>{" "}
    to the organization first.
  </p>
);

type TransferFieldsProps = {
  /** Prefixes the field ids, so several sets can share a page. */
  idPrefix: string;
  recipients: OrgMemberListItem[];
  newOwnerId: string;
  keepHistory: boolean;
  onChange: (change: { newOwnerId?: string; keepHistory?: boolean }) => void;
  disabled?: boolean;
};

/** The two choices a transfer takes: the new Owner, and the history. */
export const TransferFields = ({
  idPrefix,
  recipients,
  newOwnerId,
  keepHistory,
  onChange,
  disabled,
}: TransferFieldsProps) => (
  <>
    <Field>
      <FieldLabel htmlFor={`${idPrefix}-newOwnerId`}>New owner</FieldLabel>
      <Select
        value={newOwnerId}
        onValueChange={(value) => onChange({ newOwnerId: value })}
        disabled={disabled}
      >
        <SelectTrigger id={`${idPrefix}-newOwnerId`}>
          <SelectValue placeholder="Select a member" />
        </SelectTrigger>
        <SelectContent>
          {recipients.map((m) => (
            <SelectItem key={m.userId} value={m.userId}>
              {m.user.name} ({m.user.email})
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
    <Field orientation="horizontal" className="items-center justify-between">
      <div>
        <FieldLabel htmlFor={`${idPrefix}-keepHistory`}>
          Keep history
        </FieldLabel>
        <FieldDescription>
          {historyOutcome(keepHistory, "the new owner")}
        </FieldDescription>
      </div>
      <Switch
        id={`${idPrefix}-keepHistory`}
        checked={keepHistory}
        onCheckedChange={(checked) => onChange({ keepHistory: checked })}
        disabled={disabled}
      />
    </Field>
  </>
);
