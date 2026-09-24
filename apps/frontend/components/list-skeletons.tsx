import type { ReactNode } from "react";
import { Item, ItemActions, ItemContent } from "@/components/ui/item";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

/**
 * The loading placeholders the lists and tables render in place of their
 * rows, each laid out on the loaded markup's own frame — the same `<ul>`,
 * `Item` variant, grid, and table — so the rows land without shifting. As in
 * `TriggerRunRowSkeleton`, each text line is a box of the line's own height
 * holding a shorter bar, which is how the loaded text reads.
 */

/**
 * The announced frame around a skeleton: one `status` region, busy and named
 * for what is loading, so the placeholder is findable by label rather than by
 * its copy.
 */
export const LoadingRegion = ({
  label,
  className,
  children,
}: {
  /** What is loading: "Loading agents". */
  label: string;
  className?: string;
  children: ReactNode;
}) => (
  <div role="status" aria-busy="true" aria-label={label} className={className}>
    {children}
  </div>
);

/** One line of text: a box `lineClassName` tall holding a bar. */
export const SkeletonLine = ({
  className,
  lineClassName = "h-5",
}: {
  /** The bar: its width, and its height when not the default. */
  className?: string;
  /** The line box: the loaded text's line height. */
  lineClassName?: string;
}) => (
  <div className={cn("flex items-center", lineClassName)}>
    <Skeleton className={cn("h-3.5", className)} />
  </div>
);

/**
 * A placeholder for a word inside running text — a `<span>` with the
 * `Skeleton` look, since a `<div>` can't sit inside a `<p>`.
 */
export const InlineSkeleton = ({ className }: { className?: string }) => (
  <span
    data-slot="skeleton"
    className={cn(
      "bg-accent animate-pulse rounded-md inline-block h-3.5 w-24 align-middle",
      className,
    )}
  />
);

/** A ghost `size="icon"` button — a row's `EllipsisVertical` menu trigger. */
export const IconButtonSkeleton = () => (
  <div className="flex size-9 shrink-0 items-center justify-center">
    <Skeleton className="size-4" />
  </div>
);

/** A default-size button (`h-9`); `className` sets its width. */
export const ButtonSkeleton = ({ className }: { className?: string }) => (
  <Skeleton className={cn("h-9 w-32", className)} />
);

/** The pill badge beside a row's title (`Badge`, or the Organization pill). */
export const BadgeSkeleton = ({ className }: { className?: string }) => (
  <Skeleton className={cn("h-[22px] w-16 rounded-full", className)} />
);

/**
 * The action row beneath a list — `mt-4 flex gap-2` under a card grid, bare
 * `flex gap-2` under row lists — one button per width given.
 */
export const ButtonRowSkeleton = ({
  widths,
  className,
}: {
  /** Each button's width class, in order: `["w-32", "w-44"]`. */
  widths: string[];
  className?: string;
}) =>
  widths.length ? (
    <div className={cn("flex gap-2", className)}>
      {widths.map((width, i) => (
        <ButtonSkeleton key={i} className={width} />
      ))}
    </div>
  ) : null;

// Varied title widths, so a column of placeholders doesn't read as one bar.
const TITLE_WIDTHS = ["w-40", "w-28", "w-48", "w-32"];
const at = (widths: string[], i: number) => widths[i % widths.length];

/**
 * The `<ul className="mb-4">` of outline `Item` rows the settings lists use
 * (providers, MCP servers, webhooks): a title, an optional pill beside it and
 * an optional second line, and the trailing pencil.
 */
export const ItemRowsSkeleton = ({
  rows = 3,
  badge = false,
  secondLine = false,
}: {
  rows?: number;
  /** A pill beside the title on the first row (the Organization badge). */
  badge?: boolean;
  /** A `text-sm` line under the title (a webhook's URL). */
  secondLine?: boolean;
}) => (
  <ul className="mb-4">
    {Array.from({ length: rows }, (_, i) => (
      <li key={i} className="mb-2">
        <Item variant="outline">
          <ItemContent>
            <div className="flex items-center gap-2">
              <SkeletonLine className={at(TITLE_WIDTHS, i)} />
              {badge && i === 0 && <BadgeSkeleton className="w-24" />}
            </div>
            {secondLine && <SkeletonLine className="w-64 max-w-full" />}
          </ItemContent>
          <ItemActions>
            <Skeleton className="size-4" />
          </ItemActions>
        </Item>
      </li>
    ))}
  </ul>
);

export interface CardSkeletonProps {
  /** The `size-12` avatar tile the agent cards lead with. */
  media?: boolean;
  /** Pills beside the title, one per width class. */
  titleBadges?: string[];
  /** `text-xs` description lines under the title. */
  descriptionLines?: number;
  /** Anything the card carries under the description: a count, a badge. */
  extra?: ReactNode;
  /** The trailing actions; defaults to the row menu trigger. */
  actions?: ReactNode;
  /** A full-width row after the content, like `ItemFooter`. */
  footer?: ReactNode;
  /** Classes on the `Item`, after `h-full`: `items-stretch`. */
  className?: string;
}

/**
 * The `grid-cols-1 lg:grid-cols-2` card list most resources use (agents,
 * skills, triggers, blueprints, boards, dashboards): outline `Item` cards of
 * a title, a description, whatever the card carries below it, and the menu.
 */
export const CardGridSkeleton = ({
  cards = 4,
  media = false,
  titleBadges = [],
  descriptionLines = 1,
  extra,
  actions = <IconButtonSkeleton />,
  footer,
  className,
}: CardSkeletonProps & { cards?: number }) => (
  <ul className="grid grid-cols-1 lg:grid-cols-2 grid-rows-1 gap-2 lg:gap-4">
    {Array.from({ length: cards }, (_, i) => (
      <li key={i}>
        <Item variant="outline" className={cn("h-full", className)}>
          {media && <Skeleton className="size-12 shrink-0 rounded-lg" />}
          <ItemContent>
            <div className="flex items-center gap-2">
              <SkeletonLine className={at(TITLE_WIDTHS, i)} />
              {titleBadges.map((width, j) => (
                <BadgeSkeleton key={j} className={width} />
              ))}
            </div>
            {Array.from({ length: descriptionLines }, (_, j) => (
              <SkeletonLine
                key={j}
                lineClassName="h-[18px]"
                className={cn(
                  "h-3",
                  j === descriptionLines - 1 ? "w-3/5" : "w-full",
                )}
              />
            ))}
            {extra}
          </ItemContent>
          {actions}
          {footer}
        </Item>
      </li>
    ))}
  </ul>
);

/** The avatar-and-name cell the user and member tables lead with. */
export const UserCellSkeleton = () => (
  <div className="flex items-center gap-3">
    <Skeleton className="size-8 shrink-0 rounded-full" />
    <div className="flex flex-col">
      <SkeletonLine className="w-28" />
      <SkeletonLine lineClassName="h-4" className="h-3 w-40" />
    </div>
  </div>
);

export interface TableSkeletonColumn {
  /** The column's real heading — static, so it renders as loaded. */
  header: string;
  /** The placeholder in each of the column's cells. */
  cell: ReactNode;
  /** Classes on the heading and each cell: `text-right`. */
  className?: string;
}

/**
 * The bordered, horizontally scrolling table the admin surfaces use (users,
 * members, invitations), with its real headings over placeholder rows.
 */
export const TableSkeleton = ({
  columns,
  rows = 3,
  tableClassName,
}: {
  columns: TableSkeletonColumn[];
  rows?: number;
  /** The loaded table's own classes: its `min-w-[…]`. */
  tableClassName?: string;
}) => (
  <div className="border rounded-lg overflow-hidden">
    <div className="overflow-x-auto">
      <Table className={tableClassName}>
        <TableHeader>
          <TableRow>
            {columns.map((column) => (
              <TableHead key={column.header} className={column.className}>
                {column.header}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {Array.from({ length: rows }, (_, i) => (
            <TableRow key={i}>
              {columns.map((column) => (
                <TableCell key={column.header} className={column.className}>
                  {column.cell}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  </div>
);
