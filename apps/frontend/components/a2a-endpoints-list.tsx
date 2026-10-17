"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { Network, Plus } from "lucide-react";
import type { A2aEndpointListItem } from "@platypus/schemas";
import { Item, ItemActions, ItemContent, ItemTitle } from "./ui/item";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { useAuth } from "./auth-provider";
import { ListError } from "./list-state";
import { EmptyCard } from "@/components/empty-card";

import { useScopedSWR } from "@/hooks/use-scoped-swr";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { DisabledBadge } from "@/components/disabled-badge";
import { RowActionsMenu } from "@/components/row-actions-menu";
import { writeEntity } from "@/lib/api-write";
import { useDeleteFlow } from "@/hooks/use-delete-flow";
import { useEnabledToggle } from "@/hooks/use-enabled-toggle";
import { workspaceRoutes } from "@/lib/routes";
import {
  ButtonSkeleton,
  ItemRowsSkeleton,
  LoadingRegion,
} from "./list-skeletons";

const StatusBadge = ({ children }: { children: ReactNode }) => (
  <Badge variant="pill">{children}</Badge>
);

/** A Workspace's A2A endpoints (ADR-0032). Only the Owner adds or edits one. */
const A2aEndpointsList = ({
  orgId,
  workspaceId,
}: {
  orgId: string;
  workspaceId: string;
}) => {
  const routes = workspaceRoutes(orgId, workspaceId);
  const { ownsWorkspace } = useAuth();

  const scope = { orgId, workspaceId };
  const { data, error, isLoading, mutate } = useScopedSWR<{
    results: A2aEndpointListItem[];
  }>("a2a-endpoints", scope);

  const deleteFlow = useDeleteFlow<A2aEndpointListItem>({
    mutate,
    delete: (endpoint, url) =>
      writeEntity(url, "a2a-endpoints", scope, { id: endpoint.id }),
  });
  const toggle = useEnabledToggle<A2aEndpointListItem>({
    entity: "a2a-endpoints",
    scope,
    mutate,
  });

  if (isLoading) {
    return (
      <LoadingRegion label="Loading A2A endpoints">
        <ItemRowsSkeleton rows={2} secondLine />
        <ButtonSkeleton className="w-36" />
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

  const endpoints = toggle.apply(data?.results ?? []);

  const addButton = ownsWorkspace && (
    <Button asChild>
      <Link href={routes.settings.createA2aEndpoint}>
        <Plus /> Add endpoint
      </Link>
    </Button>
  );

  if (!endpoints.length) {
    return (
      <EmptyCard
        icon={<Network />}
        title="No A2A endpoints configured"
        description={
          ownsWorkspace
            ? "Add an endpoint to expose an agent in this workspace over A2A."
            : "There are no A2A endpoints in this workspace. Only the workspace owner can add one."
        }
        action={addButton}
      />
    );
  }

  return (
    <>
      <ul className="mb-4">
        {endpoints.map((endpoint) => (
          <li key={endpoint.id} className="mb-2">
            <Item variant="outline" asChild>
              <Link href={routes.settings.a2aEndpointDetail(endpoint.id)}>
                <ItemContent>
                  <div className="flex items-center gap-2">
                    <ItemTitle>{endpoint.name}</ItemTitle>
                    {!endpoint.enabled && <DisabledBadge />}
                    {endpoint.liveTokenCount === 0 && (
                      <StatusBadge>No active tokens</StatusBadge>
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground truncate">
                    {endpoint.agentName}
                  </p>
                </ItemContent>
                <ItemActions>
                  {/* Only the Owner writes an endpoint; anyone else gets Edit,
                      which opens the form read-only. */}
                  <RowActionsMenu
                    name={endpoint.name}
                    edit={{
                      href: routes.settings.a2aEndpointDetail(endpoint.id),
                    }}
                    toggle={
                      ownsWorkspace
                        ? {
                            enabled: endpoint.enabled,
                            onSelect: () => void toggle.toggle(endpoint),
                            disabled: toggle.isToggling(endpoint.id),
                          }
                        : undefined
                    }
                    remove={
                      ownsWorkspace
                        ? {
                            kind: "delete",
                            onSelect: () => deleteFlow.request(endpoint),
                          }
                        : undefined
                    }
                  />
                </ItemActions>
              </Link>
            </Item>
          </li>
        ))}
      </ul>
      {addButton}
      <DeleteConfirmDialog
        open={deleteFlow.open}
        onOpenChange={(open) => !open && deleteFlow.close()}
        title="Delete A2A endpoint"
        description={
          <>
            Delete <strong>{deleteFlow.target?.name}</strong>? Its URL and every
            one of its tokens stop working straight away.
          </>
        }
        onConfirm={deleteFlow.confirm}
        loading={deleteFlow.deleting}
        error={deleteFlow.error}
      />
    </>
  );
};

export { A2aEndpointsList };
