"use client";

import Link from "next/link";
import { Pencil, Plus } from "lucide-react";
import type { A2aEndpointListItem } from "@platypus/schemas";
import { Item, ItemActions, ItemContent, ItemTitle } from "./ui/item";
import { Button } from "./ui/button";
import { useAuth } from "./auth-provider";
import { ListError, ListState } from "./list-state";
import { useScopedSWR } from "@/hooks/use-scoped-swr";
import { workspaceRoutes } from "@/lib/routes";
import {
  ButtonSkeleton,
  ItemRowsSkeleton,
  LoadingRegion,
} from "./list-skeletons";

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

  const { data, error, isLoading, mutate } = useScopedSWR<{
    results: A2aEndpointListItem[];
  }>("a2a-endpoints", { orgId, workspaceId });

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

  const endpoints = data?.results ?? [];

  const addButton = ownsWorkspace && (
    <Button asChild>
      <Link href={routes.settings.createA2aEndpoint}>
        <Plus /> Add endpoint
      </Link>
    </Button>
  );

  if (!endpoints.length) {
    return (
      <ListState variant="empty" action={addButton}>
        No A2A endpoints in this workspace.
      </ListState>
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
                    {!endpoint.enabled && (
                      <span className="px-2 py-0.5 rounded-full bg-secondary text-[10px] font-medium text-secondary-foreground uppercase tracking-wider">
                        Disabled
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground truncate">
                    {endpoint.agentName}
                  </p>
                </ItemContent>
                <ItemActions>
                  <Pencil className="size-4" />
                </ItemActions>
              </Link>
            </Item>
          </li>
        ))}
      </ul>
      {addButton}
    </>
  );
};

export { A2aEndpointsList };
