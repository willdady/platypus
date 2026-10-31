"use client";

import { useState, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import { defaultFilter } from "cmdk";
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
import { SearchInput } from "@/components/search-input";
import {
  GhostCards,
  ListFooter,
  ListPagination,
  NO_GHOSTS,
  pageOf,
  type Page,
} from "@/components/list-pagination";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";
import Link from "next/link";
import { useScopedList } from "@/hooks/use-scoped-list";
import { writeEntity } from "@/lib/api-write";
import { useDeleteFlow } from "@/hooks/use-delete-flow";
import { workspaceRoutes } from "@/lib/routes";
import { replaceSearchParam } from "@/lib/search-params";
import { cn } from "@/lib/utils";

/** The card fields every entity card shows. */
type EntityCard = {
  readonly id: string;
  readonly name: string;
  readonly description?: string | null;
};

/**
 * The description's clamp, and the matching reserved height: the box is
 * always that many lines tall, so every card in the list is one height.
 */
const DESCRIPTION_LINES = {
  1: "line-clamp-1 min-h-[1lh]",
  2: "line-clamp-2 min-h-[2lh]",
} as const;

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
  descriptionLines = 2,
  ghosts = NO_GHOSTS,
  href,
  media,
  meta,
  menu,
  wrap,
  onRetry,
}: {
  items: readonly T[];
  /** Empty slots after the cards, filling a short last page or row. */
  ghosts?: Pick<Page<unknown>, "ghosts" | "rowGhosts">;
  isLoading: boolean;
  error: unknown;
  /** The plural noun loading or failing to load: "boards", "shared agents". */
  subject: string;
  /** Drawn in the loading region. */
  skeleton: ReactNode;
  /** Drawn when there are no items: a `ListState` or an `EmptyCard`. */
  empty: ReactNode;
  /** The lines the description clamps to and reserves. */
  descriptionLines?: keyof typeof DESCRIPTION_LINES;
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
  /** Reads the list again after a failed read; without it there is no Retry. */
  onRetry?: () => void;
}) {
  if (isLoading) {
    return (
      <LoadingRegion label={`Loading ${subject}`}>{skeleton}</LoadingRegion>
    );
  }

  if (error) {
    return <ListError error={error} subject={subject} onRetry={onRetry} />;
  }

  if (!items.length) {
    return empty;
  }

  const renderCard = (item: T, extras: CardExtras = {}) => {
    const content = (
      <>
        {media?.(item)}
        <ItemContent>
          <ItemTitle className="min-h-badge max-w-full">
            <span className="truncate" title={item.name}>
              {item.name}
            </span>
          </ItemTitle>
          <ItemDescription
            className={cn("text-xs", DESCRIPTION_LINES[descriptionLines])}
            title={item.description || undefined}
          >
            {item.description}
          </ItemDescription>
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
    <ul className="grid grid-cols-1 lg:grid-cols-2 auto-rows-fr gap-2 lg:gap-4">
      {items.map((item) => (
        <li key={item.id}>
          {wrap
            ? wrap(item, (extras) => renderCard(item, extras))
            : renderCard(item)}
        </li>
      ))}
      <GhostCards page={ghosts} />
    </ul>
  );
}

export type WorkspaceEntityCardListConfig = {
  /** Collection entity as the API spells it, and the key to its routes. */
  readonly entity: "boards" | "dashboards";
  /** The URL param holding the name search: "boardQuery" / "dashboardQuery". */
  readonly queryParam: "boardQuery" | "dashboardQuery";
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
  /**
   * Pages the list and draws its footer row: Create on the left, pagination
   * on the right. Without it, neither — Dashboards' Create sits in the page.
   */
  readonly paging?: {
    /** The URL param holding the page: "boardsPage". */
    readonly param: string;
    readonly pageSize: number;
    /** Names the pagination control: "Boards pages". */
    readonly label: string;
    /** The footer's Create link: "Create board". */
    readonly createLabel: string;
  };
};

/**
 * The workspace's sorted card list of a named entity, one component for
 * Boards and Dashboards. Each card links to its detail page and carries the
 * same edit/delete menu; the entity noun, search param, delete copy, and
 * confirmation phrase are the parameters.
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

  const searchParams = useSearchParams();
  // The input reads local state, seeded from the URL: the URL write below
  // lands a render later, and an input bound straight to it drops keystrokes.
  const [nameFilter, setNameFilterState] = useState(
    () => searchParams.get(config.queryParam) ?? "",
  );
  // An empty search leaves its param out. A new search starts on page 1.
  const setNameFilter = (value: string) => {
    setNameFilterState(value);
    replaceSearchParam(config.queryParam, value.trim() || null);
    if (config.paging) replaceSearchParam(config.paging.param, null);
  };

  const routes = workspaceRoutes(orgId, workspaceId)[config.entity];

  const query = nameFilter.trim();
  // The Command palette's own scorer, applied to the name.
  const cards = [...rows]
    .sort((a, b) => a.name.localeCompare(b.name))
    .filter((card) => !query || defaultFilter(card.name, query) > 0);
  const { paging } = config;
  const page = paging
    ? pageOf(searchParams.get(paging.param), cards, paging.pageSize)
    : { items: cards, page: 1, pageCount: 1, ...NO_GHOSTS };

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
      {/* Nothing to filter, no controls. */}
      {rows.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2">
          <SearchInput
            placeholder={`Search ${config.entity}…`}
            aria-label={`Search ${config.entity}`}
            value={nameFilter}
            onValueChange={setNameFilter}
            className="w-full sm:w-64"
          />
        </div>
      )}
      <EntityCardList
        items={page.items}
        ghosts={page}
        isLoading={isLoading}
        error={error}
        subject={config.entity}
        onRetry={() => void mutate()}
        skeleton={<CardGridSkeleton descriptionLines={1} />}
        empty={
          <ListState variant="empty">
            {rows.length
              ? `No ${config.entity} match your filters.`
              : `No ${config.entity} yet.`}
          </ListState>
        }
        // Nothing follows the description, so one line is all it reserves.
        descriptionLines={1}
        href={(card) => routes.detail(card.id)}
        menu={(card) => (
          <RowActionsMenu
            name={card.name}
            edit={{ href: routes.settings(card.id) }}
            remove={{ onSelect: () => deleteFlow.request(card) }}
          />
        )}
      />

      {paging && (
        <ListFooter
          pagination={
            <ListPagination
              page={page}
              param={paging.param}
              aria-label={paging.label}
            />
          }
        >
          <Button variant="outline" asChild>
            <Link href={routes.create}>
              <Plus /> {paging.createLabel}
            </Link>
          </Button>
        </ListFooter>
      )}

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
