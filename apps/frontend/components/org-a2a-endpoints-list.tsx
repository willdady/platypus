"use client";

import { Fragment } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { DisabledBadge } from "@/components/disabled-badge";
import { EmptyCard } from "@/components/empty-card";
import { Network } from "lucide-react";
import { useScopedList } from "@/hooks/use-scoped-list";
import type { Serialized } from "@/lib/api-write";
import type { OrgA2aEndpoint } from "@platypus/schemas";
import { formatDate } from "@/lib/format-date";
import { TokenCells, TokenTime } from "@/components/bearer-token";
import { TableList } from "@/components/table-list";
import {
  OVERSIGHT_TABLE_CLASS,
  OversightTableSkeleton,
  oversightColumns,
  WorkspaceOwnerCell,
} from "@/components/org-token-oversight";
import { useOrgRevoke } from "@/hooks/use-org-revoke";

/** What a revoke stops: the endpoint, or just one of its tokens. */
type RevokeTarget = {
  endpoint: Serialized<OrgA2aEndpoint>;
  token?: Serialized<OrgA2aEndpoint>["tokens"][number];
};

/**
 * Every A2A endpoint and token in the Organization, for its Org Admins. The
 * actions are revoking an endpoint or one token: either stops working at once
 * and the Workspace Owner is notified. The Organization's A2A setting is the
 * lasting off switch.
 */
export function OrgA2aEndpointsList({ orgId }: { orgId: string }) {
  const scope = { orgId };
  const {
    data,
    results: endpoints,
    error,
    isLoading,
    mutate,
  } = useScopedList<OrgA2aEndpoint>("a2a/endpoints", scope);

  const revoke = useOrgRevoke<RevokeTarget>({
    entity: "a2a/endpoints",
    scope,
    mutate,
    revokeFor: ({ endpoint, token }) => ({
      path: token ? `/${endpoint.id}/tokens/${token.id}` : `/${endpoint.id}`,
      tokenCreatedAt: token?.tokenCreatedAt,
      message: token ? "Token revoked" : "Endpoint revoked",
    }),
  });

  const owner = revoke.target?.endpoint.ownerName ?? "the workspace owner";

  return (
    <>
      <TableList
        isLoading={isLoading}
        data={data}
        error={error}
        subject="A2A endpoints"
        skeleton={<OversightTableSkeleton firstHeader="Endpoint" />}
        empty={
          <EmptyCard
            icon={<Network />}
            title="No A2A endpoints configured"
            description="No workspace in this organization has an A2A endpoint."
          />
        }
        isEmpty={endpoints.length === 0}
        onRetry={() => void mutate()}
      >
        <Table bordered className={OVERSIGHT_TABLE_CLASS}>
          <TableHeader>
            <TableRow>
              {oversightColumns("Endpoint").map((header) => (
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
                        {!endpoint.enabled && <DisabledBadge />}
                      </div>
                      <span className="text-xs text-muted-foreground">
                        Agent: {endpoint.agentName}
                      </span>
                    </div>
                  </TableCell>
                  <WorkspaceOwnerCell
                    workspaceName={endpoint.workspaceName}
                    ownerName={endpoint.ownerName}
                  />
                  <TableCell>{formatDate(endpoint.createdAt)}</TableCell>
                  <TableCell colSpan={3} />
                  <TableCell className="text-right">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => revoke.request({ endpoint })}
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
                    <TableCell>
                      <TokenTime value={token.createdAt} />
                    </TableCell>
                    <TokenCells token={token} />
                    <TableCell className="text-right">
                      <Button
                        variant="outline"
                        size="sm"
                        aria-label={`Revoke token ${token.name}`}
                        onClick={() => revoke.request({ endpoint, token })}
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
      </TableList>

      <ConfirmDialog
        open={revoke.open}
        onOpenChange={(open) => !open && revoke.close()}
        title={revoke.target?.token ? "Revoke token" : "Revoke endpoint"}
        description={
          revoke.target?.token
            ? `Calls with the token "${revoke.target.token.name}" are refused from now on, and ${owner} gets a notification. The endpoint's other tokens keep working, and the owner can issue a new token.`
            : `The endpoint "${revoke.target?.endpoint.name}" is deleted with all of its tokens, so its URL stops working. Its chats are kept, and ${owner} gets a notification. To stop the workspace having endpoints for good, change the organization's A2A setting.`
        }
        confirmLabel={revoke.target?.token ? "Revoke token" : "Revoke endpoint"}
        confirmVariant="destructive"
        onConfirm={() => void revoke.confirm()}
        loading={revoke.deleting}
        error={revoke.error}
      />
    </>
  );
}
