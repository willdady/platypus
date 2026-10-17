"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { EmptyCard } from "@/components/empty-card";
import { EntityCardList } from "@/components/entity-card-list";
import {
  ButtonRowSkeleton,
  CardGridSkeleton,
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
      <EntityCardList
        items={blueprints}
        isLoading={isLoading}
        error={error}
        subject="blueprints"
        skeleton={
          <>
            <CardGridSkeleton
              extra={
                // The "N shared resources" count.
                <SkeletonLine lineClassName="mt-1 h-4" className="h-3 w-28" />
              }
            />
            <ButtonRowSkeleton className="mt-4" widths={["w-40"]} />
          </>
        }
        empty={
          <EmptyCard
            icon={<Layers />}
            title="No blueprints yet"
            description="Create one to provision new workspaces with a set of shared resources in a single step."
            action={actions}
          />
        }
        href={(blueprint) => routes.blueprintDetail(blueprint.id)}
        meta={(blueprint) => {
          const count = blueprint.items.length;
          return (
            <div className="mt-1 text-xs text-muted-foreground">
              {count} shared resource{count !== 1 ? "s" : ""}
            </div>
          );
        }}
        menu={(blueprint) => (
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
        )}
      />

      {!isLoading && !error && blueprints.length > 0 && (
        <div className="mt-4">{actions}</div>
      )}

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
