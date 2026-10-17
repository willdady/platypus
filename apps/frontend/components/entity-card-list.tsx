"use client";

import type { ReactNode } from "react";
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
import { cn } from "@/lib/utils";

/** The card fields every entity card shows. */
type EntityCard = {
  readonly id: string;
  readonly name: string;
  readonly description?: string | null;
};

/** What `wrap` may add to a card it surrounds. */
type CardExtras = {
  /** Classes on the `Item`: `border-warning`. */
  className?: string;
  /** Rendered after `meta`. */
  meta?: ReactNode;
};

/**
 * The `grid-cols-1 lg:grid-cols-2` card list of outline `Item` cards, with
 * its loading, failed and empty states. The caller fetches, sorts, and owns
 * the dialogs and controls around it; the slots fill in what differs.
 */
export function EntityCardList<T extends EntityCard>({
  items,
  isLoading,
  error,
  subject,
  skeleton,
  empty,
  descriptionClassName = "line-clamp-2",
  href,
  media,
  meta,
  menu,
  wrap,
}: {
  items: readonly T[];
  isLoading: boolean;
  error: unknown;
  /** The plural noun loading or failing to load: "boards", "shared agents". */
  subject: string;
  /** Drawn in the loading region. */
  skeleton: ReactNode;
  /** Drawn when there are no items: a `ListState` or an `EmptyCard`. */
  empty: ReactNode;
  /** Classes on the description, after `text-xs`. */
  descriptionClassName?: string;
  /** The card links here; without it the card is not a link. */
  href?: (item: T) => string;
  /** Leads the card: an avatar. */
  media?: (item: T) => ReactNode;
  /** Rendered under the description: a count, a badge. */
  meta?: (item: T) => ReactNode;
  /** The card's `RowActionsMenu`; without it the card has no actions. */
  menu?: (item: T) => ReactNode;
  /** Surrounds each card, drawing it with `card`: a per-card read. */
  wrap?: (item: T, card: (extras?: CardExtras) => ReactNode) => ReactNode;
}) {
  if (isLoading) {
    return (
      <LoadingRegion label={`Loading ${subject}`}>{skeleton}</LoadingRegion>
    );
  }

  if (error) {
    return <ListError error={error} subject={subject} />;
  }

  if (!items.length) {
    return empty;
  }

  const renderCard = (item: T, extras: CardExtras = {}) => {
    const content = (
      <>
        {media?.(item)}
        <ItemContent>
          <ItemTitle>{item.name}</ItemTitle>
          {item.description && (
            <ItemDescription className={cn("text-xs", descriptionClassName)}>
              {item.description}
            </ItemDescription>
          )}
          {meta?.(item)}
          {extras.meta}
        </ItemContent>
        {menu && <ItemActions>{menu(item)}</ItemActions>}
      </>
    );
    const link = href?.(item);
    return link ? (
      <Item
        variant="outline"
        className={cn("h-full cursor-pointer", extras.className)}
        asChild
      >
        <Link href={link}>{content}</Link>
      </Item>
    ) : (
      <Item variant="outline" className={cn("h-full", extras.className)}>
        {content}
      </Item>
    );
  };

  return (
    <ul className="grid grid-cols-1 lg:grid-cols-2 grid-rows-1 gap-2 lg:gap-4">
      {items.map((item) => (
        <li key={item.id}>
          {wrap
            ? wrap(item, (extras) => renderCard(item, extras))
            : renderCard(item)}
        </li>
      ))}
    </ul>
  );
}

export type WorkspaceEntityCardListConfig = {
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
};

/**
 * The workspace's sorted card list of a named entity, one component for
 * Boards and Dashboards. Each card links to its detail page and carries the
 * same edit/delete menu; the entity noun, delete copy, and confirmation
 * phrase are the parameters.
 */
export function WorkspaceEntityCardList({
  orgId,
  workspaceId,
  config,
}: {
  orgId: string;
  workspaceId: string;
  config: WorkspaceEntityCardListConfig;
}) {
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

  return (
    <>
      <EntityCardList
        items={cards}
        isLoading={isLoading}
        error={error}
        subject={config.entity}
        skeleton={<CardGridSkeleton />}
        empty={<ListState variant="empty">No {config.entity} yet.</ListState>}
        href={(card) => routes.detail(card.id)}
        menu={(card) => (
          <RowActionsMenu
            name={card.name}
            edit={{ href: routes.settings(card.id) }}
            remove={{ onSelect: () => deleteFlow.request(card) }}
          />
        )}
      />

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
}
