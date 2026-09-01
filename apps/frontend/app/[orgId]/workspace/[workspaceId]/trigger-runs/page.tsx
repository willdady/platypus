"use client";

import { use, useCallback } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import useSWR from "swr";
import useSWRInfinite from "swr/infinite";
import { History, TriangleAlert } from "lucide-react";
import {
  triggerRunStatusSchema,
  TRIGGER_RUN_STATUS_LABELS,
  type Trigger,
  type TriggerRunWithTriggerList,
} from "@platypus/schemas";
import { BackButton } from "@/components/back-button";
import { TriggerRunRow } from "@/components/trigger-run-row";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useBackendUrl } from "@/app/client-context";
import { useAuth } from "@/components/auth-provider";
import { fetcher, joinUrl } from "@/lib/utils";

/**
 * How many runs a page of the list holds. The endpoint caps a request at 100;
 * runs are pruned to each Trigger's `maxRunsToKeep`, so the volume behind this
 * list is bounded and plain offset paging is enough.
 */
const PAGE_SIZE = 50;

/** The value a Select carries for "no filter" — Radix rejects an empty one. */
const ALL = "all";

type RunPage = TriggerRunWithTriggerList;

const TriggerRunsPage = ({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string }>;
}) => {
  const { orgId, workspaceId } = use(params);

  const { user } = useAuth();
  const backendUrl = useBackendUrl();
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  // Both filters live in the URL, so a filtered view survives a refresh and can
  // be handed to someone else as a link.
  const triggerFilter = searchParams.get("triggerId") ?? "";
  const statusFilter = searchParams.get("status") ?? "";
  const isFiltered = Boolean(triggerFilter || statusFilter);

  const { data: triggersData } = useSWR<{ results: Trigger[] }>(
    backendUrl && user
      ? joinUrl(
          backendUrl,
          `/organizations/${orgId}/workspaces/${workspaceId}/triggers`,
        )
      : null,
    fetcher,
  );
  const triggers = triggersData?.results ?? [];

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
      return joinUrl(
        backendUrl,
        `/organizations/${orgId}/workspaces/${workspaceId}/trigger-runs?${query.toString()}`,
      );
    },
    [backendUrl, user, orgId, workspaceId, triggerFilter, statusFilter],
  );

  const { data, error, size, setSize, isLoading } = useSWRInfinite<RunPage>(
    getKey,
    fetcher,
    // Every page already loaded refreshes on each tick, so a run can be watched
    // moving from 'running' to a terminal status wherever it sits in the list.
    // A run completing mid-session can shunt a row across a page boundary and
    // show it twice for one tick; that self-corrects on the next.
    { refreshInterval: 10000, refreshWhenHidden: false, revalidateAll: true },
  );

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

  const replaceQuery = useCallback(
    (next: URLSearchParams) => {
      const qs = next.toString();
      router.replace(`${pathname}${qs ? `?${qs}` : ""}`, { scroll: false });
    },
    [router, pathname],
  );

  const setFilter = useCallback(
    (key: "triggerId" | "status", value: string) => {
      const next = new URLSearchParams(searchParams.toString());
      if (value === ALL) {
        next.delete(key);
      } else {
        next.set(key, value);
      }
      replaceQuery(next);
    },
    [searchParams, replaceQuery],
  );

  const clearFilters = useCallback(() => {
    const next = new URLSearchParams(searchParams.toString());
    next.delete("triggerId");
    next.delete("status");
    replaceQuery(next);
  }, [searchParams, replaceQuery]);

  return (
    <div className="flex justify-center pb-8">
      <div className="w-full px-4 md:px-0 xl:w-4/5 max-w-4xl">
        <BackButton fallbackHref={`/${orgId}/workspace/${workspaceId}`} />
        <h1 className="text-2xl mb-1 font-bold">Trigger runs</h1>
        <p className="text-muted-foreground mb-4">
          Every run from every trigger in this workspace, newest first.
        </p>

        <div className="flex flex-wrap gap-2 mb-4">
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
        </div>

        {isLoading && runs.length === 0 ? (
          <div className="border rounded-lg divide-y">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="p-4">
                <div className="flex items-center gap-4 justify-between">
                  <div className="flex items-center gap-4">
                    <Skeleton className="h-5 w-16 rounded-full" />
                    <div className="flex flex-col gap-1.5">
                      <Skeleton className="h-4 w-40" />
                      <Skeleton className="h-3 w-24" />
                      <Skeleton className="h-3 w-32" />
                    </div>
                  </div>
                  <Skeleton className="h-8 w-8 rounded-md shrink-0" />
                </div>
              </div>
            ))}
          </div>
        ) : error && runs.length === 0 ? (
          // A read that failed is not an empty result. Saying "nothing matched"
          // here would be a claim about data the page never received — and the
          // likeliest cause is a filter in the URL the endpoint rejected.
          <Empty className="border border-dashed">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <TriangleAlert className="size-6" />
              </EmptyMedia>
              <EmptyTitle>Couldn&apos;t load runs</EmptyTitle>
              <EmptyDescription>
                {isFiltered
                  ? "The list could not be read. Clearing the filters may fix it."
                  : "The list could not be read. Try again in a moment."}
              </EmptyDescription>
            </EmptyHeader>
            {isFiltered && (
              <Button variant="outline" onClick={clearFilters}>
                Clear filters
              </Button>
            )}
          </Empty>
        ) : runs.length === 0 ? (
          // Two empty states: a workspace that has never run anything is a
          // different thing from a filter that matches nothing.
          <Empty className="border border-dashed">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <History className="size-6" />
              </EmptyMedia>
              {isFiltered ? (
                <>
                  <EmptyTitle>No runs match these filters</EmptyTitle>
                  <EmptyDescription>
                    Nothing in this workspace matches what you asked for. Widen
                    the filters to see more.
                  </EmptyDescription>
                </>
              ) : (
                <>
                  <EmptyTitle>No runs yet</EmptyTitle>
                  <EmptyDescription>
                    Runs appear here as the triggers in this workspace fire.
                  </EmptyDescription>
                </>
              )}
            </EmptyHeader>
            {isFiltered && (
              <Button variant="outline" onClick={clearFilters}>
                Clear filters
              </Button>
            )}
          </Empty>
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
};

export default TriggerRunsPage;
