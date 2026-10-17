"use client";

import { useState } from "react";
import {
  Item,
  ItemTitle,
  ItemActions,
  ItemDescription,
  ItemContent,
} from "@/components/ui/item";
import { Button } from "@/components/ui/button";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { ListError } from "@/components/list-state";
import { EmptyCard } from "@/components/empty-card";

import {
  ButtonRowSkeleton,
  CardGridSkeleton,
  LoadingRegion,
  SkeletonLine,
} from "@/components/list-skeletons";
import { RowActionsMenu } from "@/components/row-actions-menu";
import { Layers, Play, Plus } from "lucide-react";
import type { Blueprint } from "@platypus/schemas";
import { writeEntity, type Serialized } from "@/lib/api-write";
import { useScopedList } from "@/hooks/use-scoped-list";
import { useDeleteFlow } from "@/hooks/use-delete-flow";
import Link from "next/link";
import { ApplyBlueprintDialog } from "@/components/apply-blueprint-dialog";
import { orgRoutes } from "@/lib/routes";

export function BlueprintsList({ orgId }: { orgId: string }) {
  const routes = orgRoutes(orgId).settings;

  const [blueprintToApply, setBlueprintToApply] =
    useState<Serialized<Blueprint> | null>(null);

  const { results, error, isLoading, mutate } = useScopedList<Blueprint>(
    "blueprints",
    { orgId },
  );

  const blueprints = [...results].sort((a, b) => a.name.localeCompare(b.name));

  const deleteFlow = useDeleteFlow<Serialized<Blueprint>>({
    mutate,
    delete: (blueprint, url) =>
      writeEntity(url, "blueprints", { orgId }, { id: blueprint.id }),
  });

  if (isLoading) {
    return (
      <LoadingRegion label="Loading blueprints">
        <CardGridSkeleton
          extra={
            // The "N shared resources" count.
            <SkeletonLine lineClassName="mt-1 h-4" className="h-3 w-28" />
          }
        />
        <ButtonRowSkeleton className="mt-4" widths={["w-40"]} />
      </LoadingRegion>
    );
  }

  if (error) {
    return <ListError error={error} subject="blueprints" />;
  }

  const actions = (
    <div className="flex gap-2">
      <Button variant={blueprints.length ? "outline" : "default"} asChild>
        <Link href={routes.createBlueprint}>
          <Plus /> Create blueprint
        </Link>
      </Button>
    </div>
  );

  return (
    <>
      {blueprints.length === 0 ? (
        <EmptyCard
          icon={<Layers />}
          title="No blueprints yet"
          description="Create one to provision new workspaces with a set of shared resources in a single step."
          action={actions}
        />
      ) : (
        <ul className="grid grid-cols-1 lg:grid-cols-2 gap-2 lg:gap-4">
          {blueprints.map((blueprint) => {
            const count = blueprint.items.length;
            return (
              <li key={blueprint.id}>
                <Item
                  variant="outline"
                  className="h-full cursor-pointer"
                  asChild
                >
                  <Link href={routes.blueprintDetail(blueprint.id)}>
                    <ItemContent>
                      <ItemTitle>{blueprint.name}</ItemTitle>
                      {blueprint.description && (
                        <ItemDescription className="text-xs line-clamp-2">
                          {blueprint.description}
                        </ItemDescription>
                      )}
                      <div className="mt-1 text-xs text-muted-foreground">
                        {count} shared resource{count !== 1 ? "s" : ""}
                      </div>
                    </ItemContent>
                    <ItemActions>
                      <RowActionsMenu
                        name={blueprint.name}
                        edit={{ href: routes.blueprintDetail(blueprint.id) }}
                        actions={[
                          {
                            label: "Apply to workspace",
                            icon: <Play />,
                            onSelect: () => setBlueprintToApply(blueprint),
                          },
                        ]}
                        remove={{
                          onSelect: () => deleteFlow.request(blueprint),
                        }}
                      />
                    </ItemActions>
                  </Link>
                </Item>
              </li>
            );
          })}
        </ul>
      )}

      {blueprints.length > 0 && <div className="mt-4">{actions}</div>}

      {blueprintToApply && (
        <ApplyBlueprintDialog
          orgId={orgId}
          blueprintId={blueprintToApply.id}
          blueprintName={blueprintToApply.name}
          open={!!blueprintToApply}
          onOpenChange={(open) => !open && setBlueprintToApply(null)}
        />
      )}

      <DeleteConfirmDialog
        open={deleteFlow.open}
        onOpenChange={(open) => !open && deleteFlow.close()}
        title="Delete Blueprint"
        description={`Are you sure you want to delete "${deleteFlow.target?.name}"? Workspaces already provisioned from it are unaffected.`}
        onConfirm={deleteFlow.confirm}
        loading={deleteFlow.deleting}
        error={deleteFlow.error}
      />
    </>
  );
}
