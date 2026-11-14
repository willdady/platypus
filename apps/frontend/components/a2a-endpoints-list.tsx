"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { Network, Plus } from "lucide-react";
import type { A2aEndpointListItem } from "@platypus/schemas";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { useAuth } from "./auth-provider";
import { EmptyCard } from "@/components/empty-card";
import { EntityCardList } from "@/components/entity-card-list";

import { useScopedList } from "@/hooks/use-scoped-list";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { DisabledBadge } from "@/components/disabled-badge";
import { RowActionsMenu } from "@/components/row-actions-menu";
import { writeEntity, type Serialized } from "@/lib/api-write";
import { useDeleteFlow } from "@/hooks/use-delete-flow";
import { useEnabledToggle } from "@/hooks/use-enabled-toggle";
import { ListFooter } from "@/components/list-pagination";
import { workspaceRoutes } from "@/lib/routes";
import { ButtonRowSkeleton, CardGridSkeleton } from "./list-skeletons";

function StatusBadge({ children }: { children: ReactNode }) {
  return <Badge variant="pill">{children}</Badge>;
}

/** A Workspace's A2A endpoints (ADR-0032). Only the Owner adds or edits one. */
function A2aEndpointsList({
  orgId,
  workspaceId,
}: {
  orgId: string;
  workspaceId: string;
}) {
  const routes = workspaceRoutes(orgId, workspaceId);
  const { ownsWorkspace } = useAuth();

  const scope = { orgId, workspaceId };
  const { data, results, error, isLoading, mutate } =
    useScopedList<A2aEndpointListItem>("a2a-endpoints", scope);

  const deleteFlow = useDeleteFlow<Serialized<A2aEndpointListItem>>({
    mutate,
    delete: (endpoint, url) =>
      writeEntity(url, "a2a-endpoints", scope, { id: endpoint.id }),
  });
  const toggle = useEnabledToggle<Serialized<A2aEndpointListItem>>({
    entity: "a2a-endpoints",
    scope,
    mutate,
  });

  const endpoints = toggle.apply(results);

  const actions = ownsWorkspace && (
    <Button variant={endpoints.length ? "outline" : "default"} asChild>
      <Link href={routes.settings.createA2aEndpoint}>
        <Plus /> Add A2A endpoint
      </Link>
    </Button>
  );

  return (
    <>
      <EntityCardList
        singleColumn
        items={endpoints.map((endpoint) => ({
          ...endpoint,
          description: endpoint.agentName,
        }))}
        isLoading={isLoading}
        error={error}
        data={data}
        subject="A2A endpoints"
        onRetry={() => void mutate()}
        skeleton={
          <>
            <CardGridSkeleton singleColumn descriptionLines={1} />
            <ButtonRowSkeleton className="mt-4" widths={["w-36"]} />
          </>
        }
        empty={
          <EmptyCard
            icon={<Network />}
            title="No A2A endpoints configured"
            description={
              ownsWorkspace
                ? "Add an endpoint to expose an agent in this workspace over A2A."
                : "There are no A2A endpoints in this workspace. Only the workspace owner can add one."
            }
            action={actions}
          />
        }
        // The agent name is the card's second line and nothing follows it.
        descriptionLines={1}
        href={(endpoint) => routes.settings.a2aEndpointDetail(endpoint.id)}
        badges={(endpoint) => (
          <>
            {!endpoint.enabled && <DisabledBadge />}
            {endpoint.liveTokenCount === 0 && (
              <StatusBadge>No active tokens</StatusBadge>
            )}
          </>
        )}
        menu={(endpoint) => (
          // Only the Owner writes an endpoint; anyone else gets Edit,
          // which opens the form read-only.
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
                    onSelect: () => deleteFlow.request(endpoint),
                  }
                : undefined
            }
          />
        )}
      />

      {endpoints.length > 0 && (
        <ListFooter className="mt-4">{actions}</ListFooter>
      )}

      <DeleteConfirmDialog
        noun="A2A endpoint"
        name={deleteFlow.target?.name}
        consequence="Its URL and every one of its tokens stop working straight away."
        {...deleteFlow.dialogProps}
      />
    </>
  );
}

export { A2aEndpointsList };
