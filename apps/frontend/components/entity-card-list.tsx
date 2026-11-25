"use client";

import { type ReactNode } from "react";
import {
  Item,
  ItemTitle,
  ItemActions,
  ItemDescription,
  ItemContent,
} from "@/components/ui/item";
import { ListError } from "@/components/list-state";
import { LoadingRegion } from "@/components/list-skeletons";
import { OrganizationBadge } from "@/components/organization-badge";
import { GhostCards, NO_GHOSTS, type Page } from "@/components/list-pagination";
import Link from "next/link";
import { cn } from "@/lib/utils";

type EntityCard = {
  readonly id: string;
  readonly name: string;
  readonly description?: string | null;
};

const DESCRIPTION_LINES = {
  1: "line-clamp-1 min-h-[1lh]",
  2: "line-clamp-2 min-h-[2lh]",
} as const;

type CardExtras = {
  className?: string;
  meta?: ReactNode;
};

type EntityCardSlots<T extends EntityCard> = {
  href?: (item: T) => string | undefined;
  media?: (item: T) => ReactNode;
  badges?: (item: T) => ReactNode;
  actions?: (item: T) => ReactNode;
  actionsClassName?: string;
  meta?: (item: T) => ReactNode;
  menu?: (item: T) => ReactNode;
  wrap?: (item: T, card: (extras?: CardExtras) => ReactNode) => ReactNode;
  isShared?: (item: T) => boolean;
  singleColumn?: boolean;
};

function EntityCardGrid<T extends EntityCard>({
  items,
  ghosts = NO_GHOSTS,
  descriptionLines = 2,
  "aria-label": label,
  href,
  media,
  badges,
  actions,
  actionsClassName,
  meta,
  menu,
  wrap,
  isShared,
  singleColumn = false,
}: EntityCardSlots<T> & {
  items: readonly T[];
  ghosts?: Pick<Page<unknown>, "ghosts" | "rowGhosts">;
  descriptionLines?: keyof typeof DESCRIPTION_LINES;
  "aria-label"?: string;
}) {
  const renderCard = (item: T, extras: CardExtras = {}) => {
    const shared = isShared?.(item) ?? false;
    const actionsNode = actions?.(item);
    const menuNode = menu?.(item);
    const content = (
      <>
        {media?.(item)}
        <ItemContent>
          <ItemTitle
            className={cn(
              "min-h-badge max-w-full",
              (badges || isShared) && "min-w-0",
            )}
          >
            <span className="truncate" title={item.name}>
              {item.name}
            </span>
            {badges?.(item)}
            {shared && <OrganizationBadge />}
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
        {(actionsNode || menuNode) && (
          <ItemActions className={actionsClassName}>
            {actionsNode}
            {menuNode}
          </ItemActions>
        )}
      </>
    );
    const link = shared ? undefined : href?.(item);
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
    <ul
      aria-label={label}
      className={cn(
        "grid grid-cols-1 auto-rows-fr gap-2",
        !singleColumn && "lg:grid-cols-2 lg:gap-4",
      )}
    >
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

export type EntityCardGroup<T extends EntityCard> = {
  heading?: ReactNode;
  items: readonly T[];
  ghosts?: Pick<Page<unknown>, "ghosts" | "rowGhosts">;
  "aria-label"?: string;
  separated?: boolean;
};

export function EntityCardList<T extends EntityCard>({
  items,
  isLoading,
  error,
  data,
  subject,
  skeleton,
  empty,
  descriptionLines = 2,
  ghosts = NO_GHOSTS,
  groups,
  "aria-label": label,
  onRetry,
  ...slots
}: EntityCardSlots<T> & {
  items: readonly T[];
  ghosts?: Pick<Page<unknown>, "ghosts" | "rowGhosts">;
  isLoading: boolean;
  error: unknown;
  data?: unknown;
  subject: string;
  skeleton: ReactNode;
  empty: ReactNode;
  descriptionLines?: keyof typeof DESCRIPTION_LINES;
  groups?: readonly EntityCardGroup<T>[];
  "aria-label"?: string;
  onRetry?: () => void;
}) {
  if (isLoading) {
    return (
      <LoadingRegion label={`Loading ${subject}`}>{skeleton}</LoadingRegion>
    );
  }

  if (error && !data) {
    return <ListError error={error} subject={subject} onRetry={onRetry} />;
  }

  const shownGroups = groups?.filter((group) => group.items.length) ?? [];

  if (!items.length && !shownGroups.length) {
    return empty;
  }

  return (
    <>
      {shownGroups.map((group, i) => (
        <div key={i} className="mb-2 flex flex-col gap-2">
          {group.heading && (
            <h3 className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
              {group.heading}
            </h3>
          )}
          <EntityCardGrid
            {...slots}
            items={group.items}
            ghosts={group.ghosts}
            descriptionLines={descriptionLines}
            aria-label={group["aria-label"]}
          />
          {group.separated && <hr className="mt-4" />}
        </div>
      ))}
      {items.length > 0 && (
        <EntityCardGrid
          {...slots}
          items={items}
          ghosts={ghosts}
          descriptionLines={descriptionLines}
          aria-label={label}
        />
      )}
    </>
  );
}
