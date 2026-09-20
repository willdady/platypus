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
import { ListError, ListState } from "@/components/list-state";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EllipsisVertical, Pencil, Play, Plus, Trash2 } from "lucide-react";
import type { Blueprint } from "@platypus/schemas";
import { writeEntity } from "@/lib/api-write";
import { useScopedSWR } from "@/hooks/use-scoped-swr";
import { useDeleteFlow } from "@/hooks/use-delete-flow";
import Link from "next/link";
import { ApplyBlueprintDialog } from "@/components/apply-blueprint-dialog";

export const BlueprintsList = ({ orgId }: { orgId: string }) => {
  const editBasePath = `/${orgId}/settings/blueprints`;

  const [blueprintToApply, setBlueprintToApply] = useState<Blueprint | null>(
    null,
  );

  const { data, error, isLoading, mutate } = useScopedSWR<{
    results: Blueprint[];
  }>("blueprints", { orgId });

  const blueprints = [...(data?.results || [])].sort((a, b) =>
    a.name.localeCompare(b.name),
  );

  const deleteFlow = useDeleteFlow<Blueprint>({
    mutate,
    delete: (blueprint, url) =>
      writeEntity(url, "blueprints", { orgId }, { id: blueprint.id }),
  });

  if (isLoading) {
    return <ListState variant="loading">Loading...</ListState>;
  }

  if (error) {
    return <ListError error={error} subject="blueprints" />;
  }

  return (
    <>
      {blueprints.length === 0 ? (
        <ListState variant="empty">
          No blueprints yet. Create one to provision new workspaces with a set
          of shared resources in a single step.
        </ListState>
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
                  <Link href={`${editBasePath}/${blueprint.id}`}>
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
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            className="cursor-pointer text-muted-foreground"
                            variant="ghost"
                            size="icon"
                            onClick={(e) => e.preventDefault()}
                          >
                            <EllipsisVertical className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent
                          onClick={(e) => e.preventDefault()}
                        >
                          <DropdownMenuItem
                            className="cursor-pointer"
                            onSelect={() => setBlueprintToApply(blueprint)}
                          >
                            <Play /> Apply to workspace
                          </DropdownMenuItem>
                          <DropdownMenuItem asChild>
                            <Link
                              className="cursor-pointer"
                              href={`${editBasePath}/${blueprint.id}`}
                            >
                              <Pencil /> Edit
                            </Link>
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            className="cursor-pointer text-destructive focus:text-destructive"
                            onSelect={() => {
                              deleteFlow.request(blueprint);
                            }}
                          >
                            <Trash2 /> Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </ItemActions>
                  </Link>
                </Item>
              </li>
            );
          })}
        </ul>
      )}

      <div className="mt-4 flex gap-2">
        <Button variant="outline" asChild>
          <Link href={`${editBasePath}/create`}>
            <Plus /> Create blueprint
          </Link>
        </Button>
      </div>

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
};
