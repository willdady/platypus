"use client";

import { use, useCallback } from "react";
import { useListParams } from "@/hooks/use-list-params";
import { useScopedList } from "@/hooks/use-scoped-list";
import { useRevalidateOnRestore } from "@/hooks/use-revalidate-on-restore";
import { scopedUrl, type Serialized } from "@/lib/api-write";
import useSWRInfinite from "swr/infinite";
import { History, TriangleAlert } from "lucide-react";
import {
  triggerRunStatusSchema,
  TRIGGER_RUN_STATUS_LABELS,
  type Trigger,
  type TriggerRunWithTriggerList,
} from "@platypus/schemas";
import { TriggerRunRow } from "@/components/trigger-run-row";
import { Button } from "@/components/ui/button";
import { EmptyCard } from "@/components/empty-card";
import { ListState } from "@/components/list-state";
import { ListToolbar } from "@/components/list-toolbar";
import { ALL } from "@/lib/search-params";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TriggerRunRowSkeleton } from "@/components/trigger-run-row-skeleton";
import { LoadingRegion } from "@/components/list-skeletons";
import { useAuth, useBackendUrl } from "@/components/auth-provider";
import { fetcher } from "@/lib/utils";

/**
 * How many runs a page of the list holds. The endpoint caps a request at 100;
 * runs are pruned per Trigger — to `maxRunsToKeep`, everything inside the
 * run-rate breaker's window, and the newest suppressed rows — so the volume
 * behind this list is bounded and plain offset paging is enough.
 */
const PAGE_SIZE = 50;

type RunPage = Serialized<TriggerRunWithTriggerList>;

function TriggerRunsPage({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string }>;
}) {
  const { orgId, workspaceId } = use(params);

  const { user } = useAuth();
  const backendUrl = useBackendUrl();
  // No page param: the list pages by "Load more", not the URL.
  const { get, set } = useListParams();

  // Both filters live in the URL, so a filtered view survives a refresh and can
  // be handed to someone else as a link.
  const triggerFilter = get("triggerId") ?? "";
  const statusFilter = get("status") ?? "";
  const isFiltered = Boolean(triggerFilter || statusFilter);

  // Fired One-offs too: their runs are listed here, filterable by name.
  const { results: triggers } = useScopedList<Trigger>(
    "triggers?includeFired=true",
    { orgId, workspaceId },
  );

  const getKey = useCallback(
    (index: number, previous: RunPage | null) => {
      if (!backendUrl || !user) return null;
      // A short page is the last one — stop asking for another.
      if (previous && previous.results.length < PAGE_SIZE) return null;
      const query = new URLSearchParams({
        limit: String(PAGE_SIZE),
        offset: String(index * PAGE_SIZE),
      });
      if (triggerFilter) query.set("triggerId", triggerFilter);
      if (statusFilter) query.set("status", statusFilter);
      // `useSWRInfinite` owns its own keys, so this is the one read that
      // still gates itself — but the path shape still comes from `scopedUrl`.
      return scopedUrl(backendUrl, `trigger-runs?${query.toString()}`, {
        orgId,
        workspaceId,
      });
    },
    [backendUrl, user, orgId, workspaceId, triggerFilter, statusFilter],
  );

  const { data, error, size, setSize, isLoading, mutate } = useSWRInfinite<
    RunPage,
    unknown
  >(
    getKey,
    fetcher,
    // Every page already loaded refreshes on each tick, so a run can be watched
    // moving from 'running' to a terminal status wherever it sits in the list.
    // A run completing mid-session can shunt a row across a page boundary and
    // show it twice for one tick; that self-corrects on the next.
    { refreshInterval: 10000, refreshWhenHidden: false, revalidateAll: true },
  );

  useRevalidateOnRestore(() => void mutate());

  const runs = data?.flatMap((page) => page.results) ?? [];
  const lastPage = data?.[data.length - 1];
  const hasMore = lastPage ? lastPage.results.length === PAGE_SIZE : false;
  const isLoadingMore =
    isLoading ||
    (size > 0 && data !== undefined && data[size - 1] === undefined);

  const unlistedTrigger =
    triggerFilter && !triggers.some((trigger) => trigger.id === triggerFilter)
      ? {
          id: triggerFilter,
          name: runs[0]?.triggerName ?? triggerFilter,
        }
      : null;

  const setFilter = (key: "triggerId" | "status", value: string) =>
    set(key, value === ALL ? null : value);

  const clearFilters = () => {
    set("triggerId", null);
    set("status", null);
  };

  return (
    <div className="flex justify-center py-8">
      {/* The side gutter stays at every width: between the tablet and desktop
      breakpoints the column is the full content area, and without it the list
      touched the viewport edges. The widths are the workspace home page's, so
      the two read as one app. */}
      <div className="w-full px-4 md:px-8 xl:w-4/5 max-w-4xl">
        <h1 className="text-2xl mb-1 font-bold">Trigger runs</h1>
        <p className="text-muted-foreground mb-4">
          Recent runs from every trigger in this workspace, newest first.
        </p>

        {/* The parent supplies the space below the toolbar. */}
        <div className="mb-4">
          <ListToolbar>
            <Select
              value={triggerFilter || ALL}
              onValueChange={(value) => setFilter("triggerId", value)}
            >
              <SelectTrigger className="w-56" aria-label="Filter by trigger">
                <SelectValue placeholder="All triggers" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All triggers</SelectItem>
                {/* The filtered Trigger, while the dropdown's own list is still
                in flight or after that Trigger was deleted. Without an item
                carrying the value, the control falls back to "All triggers"
                and misreports a list that is filtered. The runs themselves
                name their Trigger, so the label is right on arrival. */}
                {unlistedTrigger && (
                  <SelectItem value={unlistedTrigger.id}>
                    {unlistedTrigger.name}
                  </SelectItem>
                )}
                {triggers.map((trigger) => (
                  <SelectItem key={trigger.id} value={trigger.id}>
                    {trigger.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select
              value={statusFilter || ALL}
              onValueChange={(value) => setFilter("status", value)}
            >
              <SelectTrigger className="w-40" aria-label="Filter by status">
                <SelectValue placeholder="All statuses" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All statuses</SelectItem>
                {/* The domain's own status vocabulary, not a hand-written copy. */}
                {triggerRunStatusSchema.options.map((status) => (
                  <SelectItem key={status} value={status}>
                    {TRIGGER_RUN_STATUS_LABELS[status]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </ListToolbar>
        </div>

        {/* No data and no error is loading — including the frames before the
          session resolves, when `getKey` has no key yet and SWR reports
          `isLoading: false`. Reading `isLoading` alone flashed "No runs yet". */}
        {!data && !error ? (
          <LoadingRegion
            label="Loading trigger runs"
            className="border rounded-lg divide-y"
          >
            {Array.from({ length: 3 }).map((_, i) => (
              <TriggerRunRowSkeleton key={i} />
            ))}
          </LoadingRegion>
        ) : error && runs.length === 0 ? (
          // A read that failed is not an empty result. Saying "nothing matched"
          // here would be a claim about data the page never received — and the
          // likeliest cause is a filter in the URL the endpoint rejected.
          <EmptyCard
            icon={<TriangleAlert />}
            title="Couldn't load runs"
            description={
              isFiltered
                ? "The list could not be read. Clearing the filters may fix it."
                : "The list could not be read. Try again in a moment."
            }
            action={
              <>
                <Button onClick={() => void mutate()}>Retry</Button>
                {isFiltered && (
                  <Button variant="outline" onClick={clearFilters}>
                    Clear filters
                  </Button>
                )}
              </>
            }
          />
        ) : runs.length === 0 ? (
          // Two empty states: a workspace that has never run anything is a
          // different thing from a filter that matches nothing. The first is
          // the screen's empty state; the second is a section within it.
          isFiltered ? (
            <ListState
              variant="empty"
              action={
                <Button variant="outline" onClick={clearFilters}>
                  Clear filters
                </Button>
              }
            >
              No runs match these filters.
            </ListState>
          ) : (
            <EmptyCard
              icon={<History />}
              title="No runs yet"
              description="Runs appear here as the triggers in this workspace fire."
            />
          )
        ) : (
          <>
            <div className="border rounded-lg divide-y">
              {runs.map((run) => (
                <TriggerRunRow
                  key={run.id}
                  run={run}
                  orgId={orgId}
                  workspaceId={workspaceId}
                />
              ))}
            </div>
            {hasMore && (
              <div className="flex justify-center mt-4">
                <Button
                  variant="outline"
                  disabled={isLoadingMore}
                  onClick={() => setSize((current) => current + 1)}
                >
                  Load more
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export default TriggerRunsPage;
