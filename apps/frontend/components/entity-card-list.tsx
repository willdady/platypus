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
import { EllipsisVertical, Pencil, Trash2 } from "lucide-react";
import Link from "next/link";
import { useScopedSWR } from "@/hooks/use-scoped-swr";
import { writeEntity } from "@/lib/api-write";
import { useBackendUrl } from "@/components/auth-provider";

/** The card fields Boards and Dashboards both expose. */
interface EntityCard {
  readonly id: string;
  readonly name: string;
  readonly description?: string | null;
}

export interface EntityCardListConfig {
  /** Collection entity as the API spells it, and the route segment for its pages. */
  readonly entity: string;
  readonly labels: {
    /** Delete confirmation title: "Delete Board" / "Delete Dashboard". */
    readonly deleteTitle: string;
    /** The entity named mid-sentence: "board" / "dashboard". */
    readonly deleteNoun: string;
    /** What deleting it takes with it: "and all of its data." / "and all of its widgets.". */
    readonly deleteTail: string;
    /** The phrase the user types to confirm: "delete board" / "delete dashboard". */
    readonly confirmPhrase: string;
  };
}

/**
 * The workspace's sorted card list of a named entity, one component for
 * Boards and Dashboards. Each card links to its detail page and carries the
 * same edit/delete menu; the entity noun, delete copy, and confirmation
 * phrase are the parameters.
 */
export const EntityCardList = ({
  orgId,
  workspaceId,
  config,
}: {
  orgId: string;
  workspaceId: string;
  config: EntityCardListConfig;
}) => {
  const backendUrl = useBackendUrl();
  const { data, isLoading, mutate } = useScopedSWR<{
    results: EntityCard[];
  }>(config.entity, { orgId, workspaceId });

  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [cardToDelete, setCardToDelete] = useState<EntityCard | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const cards = [...(data?.results || [])].sort((a, b) =>
    a.name.localeCompare(b.name),
  );

  const handleDeleteClick = (card: EntityCard) => {
    setCardToDelete(card);
    setDeleteError(null);
    setDeleteDialogOpen(true);
  };

  const handleDeleteConfirm = async () => {
    if (!cardToDelete || !backendUrl) return;

    setDeleting(true);
    setDeleteError(null);
    try {
      const outcome = await writeEntity(
        backendUrl,
        config.entity,
        { orgId, workspaceId },
        { id: cardToDelete.id },
      );
      if (outcome.outcome === "success") {
        mutate();
        setDeleteDialogOpen(false);
        setCardToDelete(null);
      } else {
        setDeleteError(outcome.message);
      }
    } finally {
      setDeleting(false);
    }
  };

  if (isLoading) {
    return <div>Loading...</div>;
  }

  if (!cards.length) {
    return null;
  }

  return (
    <>
      <ul className="grid grid-cols-1 lg:grid-cols-2 grid-rows-1 gap-2 lg:gap-4">
        {cards.map((card) => (
          <li key={card.id}>
            <Item variant="outline" className="h-full cursor-pointer" asChild>
              <Link
                href={`/${orgId}/workspace/${workspaceId}/${config.entity}/${card.id}`}
              >
                <ItemContent>
                  <ItemTitle>{card.name}</ItemTitle>
                  {card.description && (
                    <ItemDescription className="text-xs line-clamp-2">
                      {card.description}
                    </ItemDescription>
                  )}
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
                    <DropdownMenuContent>
                      <DropdownMenuItem className="cursor-pointer" asChild>
                        <Link
                          href={`/${orgId}/workspace/${workspaceId}/${config.entity}/${card.id}/settings`}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <Pencil /> Edit
                        </Link>
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        className="cursor-pointer text-destructive focus:text-destructive"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          handleDeleteClick(card);
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
        ))}
      </ul>

      <ConfirmDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        title={config.labels.deleteTitle}
        description={
          <>
            This action cannot be undone. This will permanently delete the{" "}
            {config.labels.deleteNoun}{" "}
            <span className="font-semibold">{cardToDelete?.name ?? ""}</span>{" "}
            {config.labels.deleteTail}
          </>
        }
        confirmLabel="Delete"
        confirmVariant="destructive"
        confirmPhrase={config.labels.confirmPhrase}
        loadingLabel="Deleting..."
        onConfirm={handleDeleteConfirm}
        loading={deleting}
        error={deleteError}
      />
    </>
  );
};
