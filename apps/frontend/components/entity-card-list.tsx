"use client";

import {
  Item,
  ItemTitle,
  ItemActions,
  ItemDescription,
  ItemContent,
} from "@/components/ui/item";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { ListError, ListState } from "@/components/list-state";
import { CardGridSkeleton, LoadingRegion } from "@/components/list-skeletons";
import { RowActionsMenu } from "@/components/row-actions-menu";
import Link from "next/link";
import { useScopedList } from "@/hooks/use-scoped-list";
import { writeEntity } from "@/lib/api-write";
import { useDeleteFlow } from "@/hooks/use-delete-flow";
import { workspaceRoutes } from "@/lib/routes";

/** The card fields Boards and Dashboards both expose. */
interface EntityCard {
  readonly id: string;
  readonly name: string;
  readonly description?: string | null;
}

export interface EntityCardListConfig {
  /** Collection entity as the API spells it, and the key to its routes. */
  readonly entity: "boards" | "dashboards";
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
  const {
    results: rows,
    error,
    isLoading,
    mutate,
  } = useScopedList<EntityCard>(config.entity, { orgId, workspaceId });

  const routes = workspaceRoutes(orgId, workspaceId)[config.entity];

  const cards = [...rows].sort((a, b) => a.name.localeCompare(b.name));

  const deleteFlow = useDeleteFlow<EntityCard>({
    mutate,
    delete: (card, backendUrl) =>
      writeEntity(
        backendUrl,
        config.entity,
        { orgId, workspaceId },
        {
          id: card.id,
        },
      ),
  });

  if (isLoading) {
    return (
      <LoadingRegion label={`Loading ${config.entity}`}>
        <CardGridSkeleton />
      </LoadingRegion>
    );
  }

  if (error) {
    return <ListError error={error} subject={config.entity} />;
  }

  if (!cards.length) {
    return <ListState variant="empty">No {config.entity} yet.</ListState>;
  }

  return (
    <>
      <ul className="grid grid-cols-1 lg:grid-cols-2 grid-rows-1 gap-2 lg:gap-4">
        {cards.map((card) => (
          <li key={card.id}>
            <Item variant="outline" className="h-full cursor-pointer" asChild>
              <Link href={routes.detail(card.id)}>
                <ItemContent>
                  <ItemTitle>{card.name}</ItemTitle>
                  {card.description && (
                    <ItemDescription className="text-xs line-clamp-2">
                      {card.description}
                    </ItemDescription>
                  )}
                </ItemContent>
                <ItemActions>
                  <RowActionsMenu
                    name={card.name}
                    edit={{ href: routes.settings(card.id) }}
                    remove={{ onSelect: () => deleteFlow.request(card) }}
                  />
                </ItemActions>
              </Link>
            </Item>
          </li>
        ))}
      </ul>

      <DeleteConfirmDialog
        open={deleteFlow.open}
        onOpenChange={(open) => !open && deleteFlow.close()}
        title={config.labels.deleteTitle}
        description={
          <>
            This action cannot be undone. This will permanently delete the{" "}
            {config.labels.deleteNoun}{" "}
            <span className="font-semibold">
              {deleteFlow.target?.name ?? ""}
            </span>{" "}
            {config.labels.deleteTail}
          </>
        }
        confirmPhrase={config.labels.confirmPhrase}
        onConfirm={deleteFlow.confirm}
        loading={deleteFlow.deleting}
        error={deleteFlow.error}
      />
    </>
  );
};
