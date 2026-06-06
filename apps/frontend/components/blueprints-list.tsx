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
import { ConfirmDialog } from "@/components/confirm-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EllipsisVertical, Pencil, Play, Plus, Trash2 } from "lucide-react";
import type { Blueprint } from "@platypus/schemas";
import useSWR from "swr";
import { fetcher, joinUrl } from "@/lib/utils";
import Link from "next/link";
import { useBackendUrl } from "@/app/client-context";
import { useAuth } from "@/components/auth-provider";
import { ApplyBlueprintDialog } from "@/components/apply-blueprint-dialog";

export const BlueprintsList = ({ orgId }: { orgId: string }) => {
  const { user } = useAuth();
  const backendUrl = useBackendUrl();
  const editBasePath = `/${orgId}/settings/blueprints`;

  const [blueprintToDelete, setBlueprintToDelete] = useState<Blueprint | null>(
    null,
  );
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [blueprintToApply, setBlueprintToApply] = useState<Blueprint | null>(
    null,
  );

  const { data, isLoading, mutate } = useSWR<{ results: Blueprint[] }>(
    backendUrl && user
      ? joinUrl(backendUrl, `/organizations/${orgId}/blueprints`)
      : null,
    fetcher,
  );

  const blueprints = [...(data?.results || [])].sort((a, b) =>
    a.name.localeCompare(b.name),
  );

  const handleDeleteConfirm = async () => {
    if (!blueprintToDelete || !backendUrl) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      const response = await fetch(
        joinUrl(
          backendUrl,
          `/organizations/${orgId}/blueprints/${blueprintToDelete.id}`,
        ),
        { method: "DELETE", credentials: "include" },
      );
      if (response.ok) {
        await mutate();
        setBlueprintToDelete(null);
      } else {
        const info = await response.json().catch(() => ({}));
        setDeleteError(info.error || "Failed to delete blueprint.");
      }
    } finally {
      setDeleting(false);
    }
  };

  if (isLoading) {
    return <div>Loading...</div>;
  }

  return (
    <>
      {blueprints.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No blueprints yet. Create one to provision new workspaces with a set
          of shared resources in a single step.
        </p>
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
                              setDeleteError(null);
                              setBlueprintToDelete(blueprint);
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
            <Plus /> Create Blueprint
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

      <ConfirmDialog
        open={!!blueprintToDelete}
        onOpenChange={(open) => {
          if (!open) {
            setBlueprintToDelete(null);
            setDeleteError(null);
          }
        }}
        title="Delete Blueprint"
        description={`Are you sure you want to delete "${blueprintToDelete?.name}"? Workspaces already provisioned from it are unaffected.`}
        confirmLabel="Delete"
        confirmVariant="destructive"
        onConfirm={handleDeleteConfirm}
        loading={deleting}
        error={deleteError}
      />
    </>
  );
};
