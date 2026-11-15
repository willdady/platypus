"use client";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { DisabledBadge } from "@/components/disabled-badge";
import { EmptyCard } from "@/components/empty-card";
import { Webhook } from "lucide-react";
import { useScopedList } from "@/hooks/use-scoped-list";
import type { BearerTokenStatus } from "@platypus/schemas";
import { formatDate } from "@/lib/format-date";
import { TokenCells } from "@/components/bearer-token";
import { TableList } from "@/components/table-list";
import { RowActionsMenu } from "@/components/row-actions-menu";
import {
  OVERSIGHT_TABLE_CLASS,
  OversightTableSkeleton,
  oversightColumns,
  WorkspaceOwnerCell,
} from "@/components/org-token-oversight";
import { useOrgRevoke } from "@/hooks/use-org-revoke";

/**
 * One row of `GET /organizations/:orgId/inbound-triggers` (ADR-0030): where
 * the Trigger is, whose it is, and how its token stands. Never the token.
 */
type OrgInboundTrigger = {
  id: string;
  name: string;
  enabled: boolean;
  workspaceId: string;
  workspaceName: string;
  ownerId: string;
  ownerName: string;
  createdAt: string;
  tokenStatus: BearerTokenStatus;
  tokenCreatedAt: string | null;
  tokenExpiresAt: string | null;
  lastUsedAt: string | null;
  lastRejectedAt: string | null;
};

/**
 * Every Inbound Trigger in the Organization, for its Org Admins. The one
 * action is revoking a token: it stops the token at once and notifies the
 * Workspace Owner, who can issue a new one. The Organization's Inbound
 * Triggers setting is the lasting off switch.
 */
export function OrgInboundTriggersList({ orgId }: { orgId: string }) {
  const scope = { orgId };
  const {
    data,
    results: triggers,
    error,
    isLoading,
    mutate,
  } = useScopedList<OrgInboundTrigger>("inbound-triggers", scope);

  const revoke = useOrgRevoke<OrgInboundTrigger>({
    entity: "inbound-triggers",
    scope,
    mutate,
    revokeFor: (trigger) => ({
      path: `/${trigger.id}/token`,
      tokenCreatedAt: trigger.tokenCreatedAt,
      message: "Token revoked",
    }),
  });

  return (
    <>
      <TableList
        isLoading={isLoading}
        data={data}
        error={error}
        subject="inbound triggers"
        skeleton={<OversightTableSkeleton firstHeader="Trigger" />}
        empty={
          <EmptyCard
            icon={<Webhook />}
            title="No inbound triggers yet"
            description="No workspace in this organization has an Inbound Trigger."
          />
        }
        isEmpty={triggers.length === 0}
        onRetry={() => void mutate()}
      >
        <Table bordered className={OVERSIGHT_TABLE_CLASS}>
          <TableHeader>
            <TableRow>
              {oversightColumns("Trigger").map((header) => (
                <TableHead key={header}>{header}</TableHead>
              ))}
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {triggers.map((trigger) => (
              <TableRow key={trigger.id}>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{trigger.name}</span>
                    {!trigger.enabled && <DisabledBadge />}
                  </div>
                </TableCell>
                <WorkspaceOwnerCell
                  workspaceName={trigger.workspaceName}
                  ownerName={trigger.ownerName}
                />
                <TableCell>{formatDate(trigger.createdAt)}</TableCell>
                <TokenCells token={trigger} />
                <TableCell className="text-right">
                  <RowActionsMenu
                    name={trigger.name}
                    remove={{
                      onSelect: () => revoke.request(trigger),
                      label: "Revoke token",
                      disabled: trigger.tokenStatus === "none",
                    }}
                  />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableList>

      <ConfirmDialog
        title="Revoke token"
        description={`Calls with the token for "${revoke.target?.name}" are refused from now on, and ${revoke.target?.ownerName ?? "the workspace owner"} gets a notification. The owner can issue a new token; to stop the workspace taking calls for good, change the organization's Inbound Triggers setting.`}
        confirmLabel="Revoke token"
        confirmVariant="destructive"
        {...revoke.dialogProps}
      />
    </>
  );
}
