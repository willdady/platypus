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

// why: each skeleton mirrors the loaded markup's frame, so rows land without shifting
export function LoadingRegion({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={label}
      className={className}
    >
      {children}
    </div>
  );
}

export function SkeletonLine({
  className,
  lineClassName = "h-5",
}: {
  className?: string;
  lineClassName?: string;
}) {
  return (
    <div className={cn("flex items-center", lineClassName)}>
      <Skeleton className={cn("h-3.5", className)} />
    </div>
  );
}

// why: a span, because a div cannot sit inside a paragraph
export function InlineSkeleton({ className }: { className?: string }) {
  return (
    <span
      data-slot="skeleton"
      className={cn(
        "bg-accent animate-pulse rounded-md inline-block h-3.5 w-24 align-middle",
        className,
      )}
    />
  );
}

export function IconButtonSkeleton() {
  return (
    <div className="flex size-9 shrink-0 items-center justify-center">
      <Skeleton className="size-4" />
    </div>
  );
}

export function ButtonSkeleton({ className }: { className?: string }) {
  return <Skeleton className={cn("h-9 w-32", className)} />;
}

export function BadgeSkeleton({ className }: { className?: string }) {
  return <Skeleton className={cn("h-badge w-16 rounded-full", className)} />;
}

export function ButtonRowSkeleton({
  widths,
  className,
}: {
  widths: string[];
  className?: string;
}) {
  return widths.length ? (
    <div className={cn("flex gap-2", className)}>
      {widths.map((width, i) => (
        <ButtonSkeleton key={i} className={width} />
      ))}
    </div>
  ) : null;
}

// why: varied widths, so a column of placeholders does not read as one bar
const TITLE_WIDTHS = ["w-40", "w-28", "w-48", "w-32"];
function at(widths: string[], i: number) {
  return widths[i % widths.length];
}

export function ItemRowsSkeleton({
  rows = 3,
  badge = false,
  secondLine = false,
  extra,
}: {
  rows?: number;
  badge?: boolean;
  secondLine?: boolean;
  extra?: ReactNode;
}) {
  return (
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
              {extra}
            </ItemContent>
            <ItemActions>
              <Skeleton className="size-4" />
            </ItemActions>
          </Item>
        </li>
      ))}
    </ul>
  );
}

export type CardSkeletonProps = {
  media?: boolean;
  titleBadges?: string[];
  descriptionLines?: number;
  extra?: ReactNode;
  actions?: ReactNode;
  className?: string;
};

export function CardGridSkeleton({
  cards = 4,
  media = false,
  titleBadges = [],
  descriptionLines = 2,
  extra,
  actions = <IconButtonSkeleton />,
  className,
  singleColumn = false,
}: CardSkeletonProps & { cards?: number; singleColumn?: boolean }) {
  return (
    <ul
      className={cn(
        "grid grid-cols-1 gap-2",
        !singleColumn && "lg:grid-cols-2 lg:gap-4",
      )}
    >
      {Array.from({ length: cards }, (_, i) => (
        <li key={i}>
          <Item variant="outline" className={cn("h-full", className)}>
            {media && <Skeleton className="size-12 shrink-0 rounded-full" />}
            <ItemContent>
              <div className="flex min-h-badge items-center gap-2">
                <SkeletonLine className={at(TITLE_WIDTHS, i)} />
                {titleBadges.map((width, j) => (
                  <BadgeSkeleton key={j} className={width} />
                ))}
              </div>
              <div>
                {Array.from({ length: descriptionLines }, (_, j) => (
                  <SkeletonLine
                    key={j}
                    lineClassName="h-4"
                    className={cn(
                      "h-3",
                      j === descriptionLines - 1 ? "w-3/5" : "w-full",
                    )}
                  />
                ))}
              </div>
              {extra}
            </ItemContent>
            {actions}
          </Item>
        </li>
      ))}
    </ul>
  );
}

export function UserCellSkeleton() {
  return (
    <div className="flex items-center gap-3">
      <Skeleton className="size-8 shrink-0 rounded-full" />
      <div className="flex flex-col">
        <SkeletonLine className="w-28" />
        <SkeletonLine lineClassName="h-4" className="h-3 w-40" />
      </div>
    </div>
  );
}

export type TableSkeletonColumn = {
  header: string;
  cell: ReactNode;
  className?: string;
};

export function TableSkeleton({
  columns,
  rows = 3,
  tableClassName,
}: {
  columns: TableSkeletonColumn[];
  rows?: number;
  tableClassName?: string;
}) {
  return (
    <Table bordered className={tableClassName}>
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
  );
}
