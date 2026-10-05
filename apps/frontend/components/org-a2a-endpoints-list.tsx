"use client";

import { Fragment, useState } from "react";
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
  ButtonSkeleton,
  InlineSkeleton,
  LoadingRegion,
  TableSkeleton,
} from "@/components/list-skeletons";
import { useBackendUrl } from "@/components/auth-provider";
import { useScopedSWR } from "@/hooks/use-scoped-swr";
import { scopedUrl, writeAt } from "@/lib/api-write";
import { joinUrl } from "@/lib/utils";
import type { BearerTokenStatus } from "@platypus/schemas";
import { formatDate } from "@/lib/format-date";
import { TokenCells } from "@/components/bearer-token";

/**
 * One row of `GET /organizations/:orgId/a2a/endpoints` (ADR-0032): where the
 * endpoint is, whose it is, which Agent it reaches, and how each of its tokens
 * stands. Never a token's value.
 */
interface OrgA2aEndpoint {
  id: string;
  name: string;
  enabled: boolean;
  agentName: string;
  workspaceName: string;
  ownerName: string;
  createdAt: string;
  tokens: {
    id: string;
    name: string;
    createdAt: string;
    tokenStatus: BearerTokenStatus;
    // When the current value was issued: the marker a revoke names.
    tokenCreatedAt: string;
    tokenExpiresAt: string;
    lastUsedAt: string | null;
    lastRejectedAt: string | null;
  }[];
}

/** What a revoke stops: the endpoint, or just one of its tokens. */
interface RevokeTarget {
  endpoint: OrgA2aEndpoint;
  token?: OrgA2aEndpoint["tokens"][number];
}

const COLUMNS = [
  "Endpoint",
  "Workspace",
  "Created",
  "Expires",
  "Last used",
  "Last rejected",
] as const;

/**
 * Every A2A endpoint and token in the Organization, for its Org Admins. The
 * actions are revoking an endpoint or one token: either stops working at once
 * and the Workspace Owner is notified. The Organization's A2A setting is the
 * lasting off switch.
 */
export const OrgA2aEndpointsList = ({ orgId }: { orgId: string }) => {
  const backendUrl = useBackendUrl();
  const scope = { orgId };
  const { data, error, isLoading, mutate } = useScopedSWR<{
    results: OrgA2aEndpoint[];
  }>("a2a/endpoints", scope);
  const [toRevoke, setToRevoke] = useState<RevokeTarget | null>(null);
  const [isRevoking, setIsRevoking] = useState(false);

  const handleRevoke = async () => {
    if (!backendUrl || !toRevoke) return;
    setIsRevoking(true);
    const { endpoint, token } = toRevoke;
    const outcome = await writeAt(
      joinUrl(
        scopedUrl(backendUrl, "a2a/endpoints", scope),
        // Names the value this row showed, so a token the Owner regenerated
        // since the list loaded is refused rather than revoked unseen.
        token
          ? `/${endpoint.id}/tokens/${token.id}?${new URLSearchParams({ tokenCreatedAt: token.tokenCreatedAt })}`
          : `/${endpoint.id}`,
      ),
      { method: "DELETE" },
    );
    if (outcome.outcome === "success") {
      toast.success(token ? "Token revoked" : "Endpoint revoked");
    } else {
      toast.error(outcome.message);
    }
    // After a failure too: a token regenerated since the list loaded is
    // refused, and the list should show the one that is current now.
    await mutate();
    setIsRevoking(false);
    setToRevoke(null);
  };

  if (isLoading) {
    return (
      <LoadingRegion label="Loading A2A endpoints">
        <TableSkeleton
          tableClassName="min-w-[720px]"
          columns={[
            ...COLUMNS.map((header) => ({
              header,
              cell: <InlineSkeleton className="w-20" />,
            })),
            {
              header: "Actions",
              className: "text-right",
              cell: (
                <div className="flex justify-end">
                  <ButtonSkeleton className="w-24" />
                </div>
              ),
            },
          ]}
        />
      </LoadingRegion>
    );
  }

  if (error && !data) {
    return <ListError error={error} subject="A2A endpoints" />;
  }

  const endpoints = data?.results ?? [];
  if (!endpoints.length) {
    return (
      <ListState variant="empty">
        No workspace in this organization has an A2A endpoint.
      </ListState>
    );
  }

  const owner = toRevoke?.endpoint.ownerName ?? "the workspace owner";

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
              {endpoints.map((endpoint) => (
                <Fragment key={endpoint.id}>
                  <TableRow>
                    <TableCell>
                      <div className="flex flex-col">
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{endpoint.name}</span>
                          {!endpoint.enabled && (
                            <Badge variant="secondary" className="text-xs">
                              Disabled
                            </Badge>
                          )}
                        </div>
                        <span className="text-xs text-muted-foreground">
                          Agent: {endpoint.agentName}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell>
                      {/* The Owner, not the Admin: the run acts as them and a
                          revoke notifies them. */}
                      <div className="flex flex-col">
                        <span>{endpoint.workspaceName}</span>
                        <span className="text-xs text-muted-foreground">
                          {endpoint.ownerName}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell>{formatDate(endpoint.createdAt)}</TableCell>
                    <TableCell colSpan={3} />
                    <TableCell className="text-right">
                      <Button
                        variant="outline"
                        size="sm"
                        className="cursor-pointer"
                        onClick={() => setToRevoke({ endpoint })}
                      >
                        Revoke endpoint
                      </Button>
                    </TableCell>
                  </TableRow>
                  {endpoint.tokens.map((token) => (
                    <TableRow key={token.id}>
                      <TableCell className="pl-8">
                        <span className="text-muted-foreground">Token: </span>
                        {token.name}
                      </TableCell>
                      <TableCell />
                      <TableCell>{formatDate(token.createdAt)}</TableCell>
                      <TokenCells token={token} />
                      <TableCell className="text-right">
                        <Button
                          variant="outline"
                          size="sm"
                          className="cursor-pointer"
                          aria-label={`Revoke token ${token.name}`}
                          onClick={() => setToRevoke({ endpoint, token })}
                        >
                          Revoke token
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </Fragment>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>

      <ConfirmDialog
        open={toRevoke !== null}
        onOpenChange={(open) => !open && setToRevoke(null)}
        title={toRevoke?.token ? "Revoke token" : "Revoke endpoint"}
        description={
          toRevoke?.token
            ? `Calls with the token "${toRevoke.token.name}" are refused from now on, and ${owner} gets a notification. The endpoint's other tokens keep working, and the owner can issue a new token.`
            : `The endpoint "${toRevoke?.endpoint.name}" is deleted with all of its tokens, so its URL stops working. Its chats are kept, and ${owner} gets a notification. To stop the workspace having endpoints for good, change the organization's A2A setting.`
        }
        confirmLabel={toRevoke?.token ? "Revoke token" : "Revoke endpoint"}
        confirmVariant="destructive"
        onConfirm={() => void handleRevoke()}
        loading={isRevoking}
      />
    </>
  );
};
