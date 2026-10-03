"use client";

import { useState } from "react";
import { toast } from "sonner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { ListError, ListState } from "@/components/list-state";
import {
  BadgeSkeleton,
  ButtonSkeleton,
  InlineSkeleton,
  LoadingRegion,
  TableSkeleton,
} from "@/components/list-skeletons";
import { useBackendUrl } from "@/components/auth-provider";
import { useScopedSWR } from "@/hooks/use-scoped-swr";
import { scopedUrl, writeAt } from "@/lib/api-write";
import { joinUrl } from "@/lib/utils";
import type { InboundTokenStatus } from "@platypus/schemas";
import { formatDate, formatDateTime } from "@/lib/format-date";
import {
  INBOUND_TOKEN_STATUS_LABELS,
  INBOUND_TOKEN_STATUS_VARIANTS,
} from "@/lib/inbound-trigger";

/**
 * One row of `GET /organizations/:orgId/inbound-triggers` (ADR-0030): where
 * the Trigger is, whose it is, and how its token stands. Never the token.
 */
interface OrgInboundTrigger {
  id: string;
  name: string;
  enabled: boolean;
  workspaceId: string;
  workspaceName: string;
  ownerId: string;
  ownerName: string;
  createdAt: string;
  tokenStatus: InboundTokenStatus;
  tokenCreatedAt: string | null;
  tokenExpiresAt: string | null;
  lastUsedAt: string | null;
  lastRejectedAt: string | null;
}

const COLUMNS = [
  "Trigger",
  "Workspace",
  "Created",
  "Expires",
  "Last used",
  "Last rejected",
] as const;

/**
 * Every Inbound Trigger in the Organization, for its Org Admins. The one
 * action is revoking a token: it stops the token at once and notifies the
 * Workspace Owner, who can issue a new one. The Organization's Inbound
 * Triggers setting is the lasting off switch.
 */
export const OrgInboundTriggersList = ({ orgId }: { orgId: string }) => {
  const backendUrl = useBackendUrl();
  const scope = { orgId };
  const { data, error, isLoading, mutate } = useScopedSWR<{
    results: OrgInboundTrigger[];
  }>("inbound-triggers", scope);
  const [toRevoke, setToRevoke] = useState<OrgInboundTrigger | null>(null);
  const [isRevoking, setIsRevoking] = useState(false);

  const handleRevoke = async () => {
    if (!backendUrl || !toRevoke) return;
    setIsRevoking(true);
    // Names the token this row showed, so a token the Owner regenerated since
    // the list loaded is refused rather than revoked unseen.
    const seen = new URLSearchParams({
      tokenCreatedAt: toRevoke.tokenCreatedAt ?? "",
    });
    const outcome = await writeAt(
      joinUrl(
        scopedUrl(backendUrl, "inbound-triggers", scope),
        `/${toRevoke.id}/token?${seen}`,
      ),
      { method: "DELETE" },
    );
    if (outcome.outcome === "success") {
      toast.success("Token revoked");
    } else {
      toast.error(outcome.message);
    }
    // After a failure too: a token replaced since the list loaded is refused,
    // and the list should show the one that is current now.
    await mutate();
    setIsRevoking(false);
    setToRevoke(null);
  };

  if (isLoading) {
    return (
      <LoadingRegion label="Loading inbound triggers">
        <TableSkeleton
          tableClassName="min-w-[720px]"
          columns={[
            ...COLUMNS.map((header) => ({
              header,
              cell:
                header === "Expires" ? (
                  <BadgeSkeleton className="w-16" />
                ) : (
                  <InlineSkeleton className="w-20" />
                ),
            })),
            {
              header: "Actions",
              className: "text-right",
              cell: (
                <div className="flex justify-end">
                  <ButtonSkeleton className="w-20" />
                </div>
              ),
            },
          ]}
        />
      </LoadingRegion>
    );
  }

  if (error && !data) {
    return <ListError error={error} subject="inbound triggers" />;
  }

  const triggers = data?.results ?? [];
  if (!triggers.length) {
    return (
      <ListState variant="empty">
        No workspace in this organization has an Inbound Trigger.
      </ListState>
    );
  }

  return (
    <>
      <div className="border rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <Table className="min-w-[720px]">
            <TableHeader>
              <TableRow>
                {COLUMNS.map((header) => (
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
                      {!trigger.enabled && (
                        <Badge variant="secondary" className="text-xs">
                          Disabled
                        </Badge>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    {/* The Owner, not the Admin: the run acts as them and a
                        revoke notifies them. */}
                    <div className="flex flex-col">
                      <span>{trigger.workspaceName}</span>
                      <span className="text-xs text-muted-foreground">
                        {trigger.ownerName}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell>{formatDate(trigger.createdAt)}</TableCell>
                  <TableCell>
                    {/* A date like the other columns; only a token that needs
                        attention gets a badge under it. */}
                    {trigger.tokenExpiresAt ? (
                      <div className="flex flex-col gap-1">
                        <span>{formatDate(trigger.tokenExpiresAt)}</span>
                        {(trigger.tokenStatus === "expiring" ||
                          trigger.tokenStatus === "expired") && (
                          <Badge
                            variant={
                              INBOUND_TOKEN_STATUS_VARIANTS[trigger.tokenStatus]
                            }
                            className="w-fit text-xs"
                          >
                            {INBOUND_TOKEN_STATUS_LABELS[trigger.tokenStatus]}
                          </Badge>
                        )}
                      </div>
                    ) : (
                      INBOUND_TOKEN_STATUS_LABELS.none
                    )}
                  </TableCell>
                  <TableCell>
                    {trigger.lastUsedAt
                      ? formatDateTime(trigger.lastUsedAt)
                      : "Never"}
                  </TableCell>
                  <TableCell>
                    {trigger.lastRejectedAt
                      ? formatDateTime(trigger.lastRejectedAt)
                      : "Never"}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="outline"
                      size="sm"
                      className="cursor-pointer"
                      disabled={trigger.tokenStatus === "none"}
                      onClick={() => setToRevoke(trigger)}
                    >
                      Revoke token
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>

      <ConfirmDialog
        open={toRevoke !== null}
        onOpenChange={(open) => !open && setToRevoke(null)}
        title="Revoke token"
        description={`Calls with the token for "${toRevoke?.name}" are refused from now on, and ${toRevoke?.ownerName ?? "the workspace owner"} gets a notification. The owner can issue a new token; to stop the workspace taking calls for good, change the organization's Inbound Triggers setting.`}
        confirmLabel="Revoke token"
        confirmVariant="destructive"
        onConfirm={() => void handleRevoke()}
        loading={isRevoking}
      />
    </>
  );
};
