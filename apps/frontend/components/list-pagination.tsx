"use client";

import type { ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { replaceSearchParam } from "@/lib/search-params";
import { cn } from "@/lib/utils";

/** A page of a list, and where it sits. */
export type Page<T> = {
  items: readonly T[];
  page: number;
  pageCount: number;
  /**
   * Slots a short last page is missing in the two-column layout; 0 when
   * there is only one page. Drawn on wide screens only.
   */
  ghosts: number;
  /**
   * Slots completing a lone page's half-full last row in the two-column
   * layout; drawn on wide screens only, where that row exists.
   */
  rowGhosts: number;
};

/** The ghost counts of a list that is not paged: none. */
export const NO_GHOSTS = { ghosts: 0, rowGhosts: 0 } as const;

/**
 * The page of `items` that `requested` (a URL param's raw value) asks for,
 * clamped rather than trusted: a malformed or too-small number reads as page
 * 1, and one past the end — a hand-edited URL, or a list that shrank under
 * it — as the last page.
 */
export function pageOf<T>(
  requested: string | null,
  items: readonly T[],
  pageSize: number,
): Page<T> {
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const page = Math.min(
    Math.max(Number.parseInt(requested ?? "", 10) || 1, 1),
    pageCount,
  );
  const shown = items.slice((page - 1) * pageSize, page * pageSize);
  return {
    items: shown,
    page,
    pageCount,
    ghosts: pageCount > 1 ? pageSize - shown.length : 0,
    rowGhosts: pageCount > 1 ? 0 : shown.length % 2,
  };
}

/**
 * Empty, dashed slots that fill a short last page out to a full one, so the
 * footer and the sections below stay put, or a lone page's last row out to
 * two. They are for the two-column layout, so they show on wide screens only:
 * a single column would end in a stack of empty cards. The grid needs
 * `auto-rows-fr`, so a row of only ghosts is as tall as a row of cards.
 */
export function GhostCards({
  page: { ghosts, rowGhosts },
}: {
  page: Pick<Page<unknown>, "ghosts" | "rowGhosts">;
}) {
  return Array.from({ length: ghosts + rowGhosts }, (_, i) => (
    // An SVG outline, not `border-dashed`: CSS cannot set a dash's spacing.
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

/**
 * Previous, "Page N of M", Next, writing the page to the URL under `param`
 * (page 1 leaves it out). Nothing when there is only one page.
 */
export function ListPagination({
  page: { page, pageCount },
  param,
  "aria-label": label,
}: {
  page: Page<unknown>;
  param: string;
  /** Names the section: four of these share the Workspace home. */
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

/**
 * A list's footer: its Create controls on the left, its pagination on the
 * right, wrapping below them on a narrow screen.
 */
export function ListFooter({
  className,
  children,
  pagination,
}: {
  className?: string;
  /** The Create controls. */
  children: ReactNode;
  pagination?: ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-between gap-2",
        className,
      )}
    >
      <div className="flex flex-wrap gap-2">{children}</div>
      {pagination}
    </div>
  );
}
