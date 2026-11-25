"use client";

import type { ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { replaceSearchParam } from "@/lib/search-params";
import { cn } from "@/lib/utils";

export type Page<T> = {
  items: readonly T[];
  page: number;
  pageCount: number;
  ghosts: number;
  rowGhosts: number;
};

export const NO_GHOSTS = { ghosts: 0, rowGhosts: 0 } as const;

// why: separate from pageOf, so a server-paged list can clamp before it has rows
export function pageBounds(
  requested: string | number | null,
  totalCount: number,
  pageSize: number,
): { page: number; pageCount: number } {
  const pageCount = Math.max(1, Math.ceil(totalCount / pageSize));
  const parsed =
    typeof requested === "number"
      ? requested
      : Number.parseInt(requested ?? "", 10) || 1;
  return { page: Math.min(Math.max(parsed, 1), pageCount), pageCount };
}

export function serverPage<T>(
  items: readonly T[],
  page: number,
  pageCount: number,
  pageSize: number,
): Page<T> {
  return {
    items,
    page,
    pageCount,
    ghosts: pageCount > 1 ? pageSize - items.length : 0,
    rowGhosts: pageCount > 1 ? 0 : items.length % 2,
  };
}

export function pageOf<T>(
  requested: string | null,
  items: readonly T[],
  pageSize: number,
): Page<T> {
  const { page, pageCount } = pageBounds(requested, items.length, pageSize);
  const shown = items.slice((page - 1) * pageSize, page * pageSize);
  return serverPage(shown, page, pageCount, pageSize);
}

export function GhostCards({
  page: { ghosts, rowGhosts },
}: {
  page: Pick<Page<unknown>, "ghosts" | "rowGhosts">;
}) {
  return Array.from({ length: ghosts + rowGhosts }, (_, i) => (
    // why: an SVG outline, because CSS cannot set a border dash's spacing
    <li
      key={`ghost-${i}`}
      aria-hidden="true"
      className="relative hidden text-border lg:block"
    >
      <svg className="absolute inset-0 size-full overflow-visible">
        <rect
          width="100%"
          height="100%"
          rx="6"
          fill="none"
          stroke="currentColor"
          strokeDasharray="6 4"
        />
      </svg>
    </li>
  ));
}

export function ListPagination({
  page: { page, pageCount },
  param,
  "aria-label": label,
}: {
  page: Page<unknown>;
  param: string;
  "aria-label": string;
}) {
  if (pageCount <= 1) return null;
  const setPage = (next: number) =>
    replaceSearchParam(param, next > 1 ? String(next) : null);
  return (
    <nav aria-label={label} className="flex items-center gap-2">
      <Button
        variant="ghost"
        size="icon"
        aria-label="Previous page"
        disabled={page <= 1}
        onClick={() => setPage(page - 1)}
      >
        <ChevronLeft />
      </Button>
      <span className="text-sm text-muted-foreground">
        Page {page} of {pageCount}
      </span>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Next page"
        disabled={page >= pageCount}
        onClick={() => setPage(page + 1)}
      >
        <ChevronRight />
      </Button>
    </nav>
  );
}

// why: inside a gap-4 parent leave className alone; a settings page passes mt-4
export function ListFooter({
  className,
  children,
  pagination,
}: {
  className?: string;
  children?: ReactNode;
  pagination?: ReactNode;
}) {
  return (
    <div
      data-slot="list-footer"
      className={cn(
        "flex flex-wrap items-center justify-between gap-2",
        className,
      )}
    >
      {children && <div className="flex flex-wrap gap-2">{children}</div>}
      {pagination}
    </div>
  );
}
