"use client";

import { use, useCallback, useRef } from "react";
import { useScopedSWR } from "@/hooks/use-scoped-swr";
import { TriangleAlert } from "lucide-react";
import type { RunEvent, TriggerRunDetailResponse } from "@platypus/schemas";
import { BackButton } from "@/components/back-button";
import { TriggerRunRow } from "@/components/trigger-run-row";
import { RunTimeline } from "@/components/run-timeline";
import {
  Message,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { fetcher } from "@/lib/utils";
import { mergeRunEvents, nextSinceSeq } from "@/lib/run-timeline";

/**
 * How often the page re-reads a run that is still running. Events reach the
 * database on the sink's flush interval, so polling faster than this would
 * deliver the same staleness with more requests — and a live channel would
 * deliver it over new transport, which is why there is none.
 */
export const RUN_DETAIL_POLL_MS = 5_000;

/** What the page says when the run cannot be read at all. */
export const RUN_DETAIL_ERROR_NOTICE =
  "This run could not be read. It may have been pruned by the trigger's Max Runs to Keep, or it belongs to another workspace.";

/**
 * One Trigger run in full: its row as the list shows it, its **Run timeline**
 * as a waterfall, and the answer it left behind.
 *
 * The timeline is read incrementally. The first request takes everything;
 * each poll after that asks only for events past a sequence number, and the
 * page folds them into what it already holds. Because an event is written
 * open and patched when it closes, the page asks from just below its oldest
 * still-running event — see `nextSinceSeq` — so the patches reach it too.
 */
const TriggerRunDetailPage = ({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string; runId: string }>;
}) => {
  const { orgId, workspaceId, runId } = use(params);

  // The events the page has accumulated so far, across polls. A ref rather
  // than state: the fetcher reads it to decide what to ask for, and SWR's
  // returned data is what renders.
  const heldEvents = useRef<RunEvent[]>([]);

  const fetchIncrementally = useCallback(
    async (url: string): Promise<TriggerRunDetailResponse> => {
      const sinceSeq = nextSinceSeq(heldEvents.current);
      const page = (await fetcher(
        sinceSeq === undefined ? url : `${url}?sinceSeq=${sinceSeq}`,
      )) as TriggerRunDetailResponse;
      heldEvents.current = mergeRunEvents(heldEvents.current, page.events);
      return { run: page.run, events: heldEvents.current };
    },
    [],
  );

  const { data, error, isLoading } = useScopedSWR<TriggerRunDetailResponse>(
    `trigger-runs/${runId}`,
    { orgId, workspaceId },
    {
      fetcher: fetchIncrementally,
      refreshInterval: (latest) =>
        latest?.run.status === "running" || latest?.run.status === "pending"
          ? RUN_DETAIL_POLL_MS
          : 0,
      refreshWhenHidden: false,
      revalidateOnFocus: false,
    },
  );

  const listHref = `/${orgId}/workspace/${workspaceId}/trigger-runs`;

  return (
    <div className="flex justify-center pb-8">
      {/* The side gutter stays at every width: between the tablet and desktop
      breakpoints the column is the full content area, and without it the list
      touched the sidebar on one side and the viewport on the other. The
      widths are the workspace home page's, so the two read as one app. */}
      <div className="w-full px-4 md:px-8 xl:w-4/5 max-w-4xl">
        <BackButton fallbackHref={listHref} />
        <h1 className="text-2xl mb-1 font-bold">Trigger run</h1>
        <p className="text-muted-foreground mb-4">
          Where this run&apos;s time went, and what it concluded.
        </p>

        {isLoading && !data ? (
          <div className="space-y-4">
            <div className="border rounded-lg p-4">
              <Skeleton className="h-5 w-40 mb-2" />
              <Skeleton className="h-4 w-64" />
            </div>
            <Skeleton className="h-40 w-full rounded-lg" />
          </div>
        ) : error && !data ? (
          <Empty className="border border-dashed">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <TriangleAlert className="size-6" />
              </EmptyMedia>
              <EmptyTitle>Couldn&apos;t load this run</EmptyTitle>
              <EmptyDescription>{RUN_DETAIL_ERROR_NOTICE}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : data ? (
          <div className="space-y-6">
            <div className="border rounded-lg">
              <TriggerRunRow
                run={data.run}
                orgId={orgId}
                workspaceId={workspaceId}
                linkToDetail={false}
              />
            </div>

            <section>
              <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide mb-2">
                Timeline
              </h2>
              <RunTimeline
                events={data.events}
                runStatus={data.run.status}
                eventsTruncated={data.run.eventsTruncated}
              />
            </section>

            {data.run.finalText && (
              <section>
                <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide mb-2">
                  Response
                </h2>
                <div className="border rounded-lg p-4">
                  {/* The chat column caps a message at 80% and lets its inner
                      column shrink to fit the content; here the Response is
                      the only thing in its box, so both take the whole width
                      and a table's frame reaches the edge. */}
                  <Message
                    from="assistant"
                    className="max-w-full sm:max-w-full [&>div]:flex-1"
                  >
                    <MessageContent className="w-full max-w-full">
                      <MessageResponse>{data.run.finalText}</MessageResponse>
                    </MessageContent>
                  </Message>
                </div>
              </section>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
};

export default TriggerRunDetailPage;
