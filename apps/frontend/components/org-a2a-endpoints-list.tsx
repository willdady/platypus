"use client";

import { Fragment } from "react";
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
import { ListError } from "@/components/list-state";
import { EmptyCard } from "@/components/empty-card";
import { Network } from "lucide-react";
import {
  ButtonSkeleton,
  InlineSkeleton,
  LoadingRegion,
  TableSkeleton,
} from "@/components/list-skeletons";
import { useScopedList } from "@/hooks/use-scoped-list";
import { useDeleteFlow } from "@/hooks/use-delete-flow";
import { scopedUrl, writeAt, type Serialized } from "@/lib/api-write";
import { joinUrl } from "@/lib/utils";
import type { OrgA2aEndpoint } from "@platypus/schemas";
import { formatDate } from "@/lib/format-date";
import { TokenCells, TokenTime } from "@/components/bearer-token";

/** What a revoke stops: the endpoint, or just one of its tokens. */
type RevokeTarget = {
  endpoint: Serialized<OrgA2aEndpoint>;
  token?: Serialized<OrgA2aEndpoint>["tokens"][number];
};

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
export function OrgA2aEndpointsList({ orgId }: { orgId: string }) {
  const scope = { orgId };
  const {
    data,
    results: endpoints,
    error,
    isLoading,
    mutate,
  } = useScopedList<OrgA2aEndpoint>("a2a/endpoints", scope);

  const revoke = useDeleteFlow<RevokeTarget>({
    delete: async ({ endpoint, token }, backendUrl) => {
      const outcome = await writeAt(
        joinUrl(
          scopedUrl(backendUrl, "a2a/endpoints", scope),
          // Names the value this row showed, so a token the Owner regenerated
          // since the list loaded is refused rather than revoked unseen.
          token
            ? `/${endpoint.id}/tokens/${token.id}?${new URLSearchParams({ tokenCreatedAt: new Date(token.tokenCreatedAt).toISOString() })}`
            : `/${endpoint.id}`,
        ),
        { method: "DELETE" },
      );
      // After a failure too: a token regenerated since the list loaded is
      // refused, and the list should show the one that is current now.
      if (outcome.outcome !== "success") await mutate();
      return outcome;
    },
    mutate,
    onSuccess: ({ token }) =>
      toast.success(token ? "Token revoked" : "Endpoint revoked"),
  });

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
    return (
      <ListError
        error={error}
        subject="A2A endpoints"
        onRetry={() => void mutate()}
      />
    );
  }

  if (!endpoints.length) {
    return (
      <EmptyCard
        icon={<Network />}
        title="No A2A endpoints configured"
        description="No workspace in this organization has an A2A endpoint."
      />
    );
  }

  const owner = revoke.target?.endpoint.ownerName ?? "the workspace owner";

  return (
    <>
      <Table bordered className="min-w-[720px]">
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
