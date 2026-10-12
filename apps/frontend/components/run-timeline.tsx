"use client";

import { useMemo } from "react";
import { ListTree, TriangleAlert } from "lucide-react";
import type { RunEvent, TriggerRunStatus } from "@platypus/schemas";
import { ActivityRow } from "@/components/activity-row";
import { EmptyCard } from "@/components/empty-card";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { TurnNotice } from "@/components/turn-notice";
import {
  barGeometry,
  layoutTimeline,
  type TimelineRow,
} from "@/lib/run-timeline";
import { formatToolDuration } from "@/lib/tool-duration";
import { cn } from "@/lib/utils";

/**
 * What the timeline says about a run that recorded nothing — one that ran
 * before timelines existed, or failed before its first step. A constant so
 * tests assert the wording without restating it.
 */
export const RUN_TIMELINE_EMPTY_NOTICE =
  "No timeline was recorded for this run. Runs that finished before timelines were introduced, and runs that failed before their first step, have none.";

/** What a run whose timeline hit the event ceiling is marked with. */
export const RUN_TIMELINE_TRUNCATED_NOTICE =
  "This run recorded more events than a timeline keeps, so later events are missing.";

/** How an event whose end nobody saw is labelled in place of a duration. */
export const UNKNOWN_DURATION_LABEL = "Unknown duration";

const barColor: Record<RunEvent["type"], string> = {
  "tool-call": "bg-blue-500",
  reasoning: "bg-purple-500",
  text: "bg-amber-500",
  delegate: "bg-emerald-500",
};

const Bar = ({ row, totalMs }: { row: TimelineRow; totalMs: number }) => {
  const { left, width } = barGeometry(row, totalMs);
  const style = { left: `${left * 100}%`, width: `${width * 100}%` };

  if (row.end.kind === "unknown") {
    // A marker at the start and a label, never a bar drawn to "now": the
    // event's end was not observed, and a bar would claim it was.
    return (
      <>
        <span
          className="absolute top-1 h-4 min-w-[3px] rounded-sm border border-dashed border-muted-foreground/60"
          style={style}
          aria-hidden
        />
        <span
          className="absolute top-1 ml-2 text-xs italic text-muted-foreground whitespace-nowrap"
          style={{ left: `${Math.min(left, 0.85) * 100}%` }}
        >
          {UNKNOWN_DURATION_LABEL}
        </span>
      </>
    );
  }

  const failed = row.event.status === "error";
  const cancelled = row.event.status === "cancelled";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            "absolute top-1 h-4 min-w-[3px] rounded-sm",
            cancelled ? "bg-muted-foreground/40" : barColor[row.event.type],
            failed && "ring-2 ring-red-500",
            row.end.kind === "running" && "animate-pulse",
          )}
          style={style}
          role="img"
          aria-label={`${row.event.type} bar`}
        />
      </TooltipTrigger>
      <TooltipContent>
        Started at +{formatToolDuration(row.offsetMs)}
        {row.end.kind === "known" &&
          ` · took ${formatToolDuration(row.end.durationMs)}`}
      </TooltipContent>
    </Tooltip>
  );
};

/**
 * A Trigger run's **Run timeline** as a waterfall: one row per Run event, the
 * label on the left and a bar on the right laid out against the run's whole
 * span, nested where a delegation opened its own run. Where a run's time went,
 * and only that — it says what kind of thing ran and for how long, never what
 * it said (that is the boundary ADR-0023 draws, and the reason there is no
 * input or output to expand).
 */
export const RunTimeline = ({
  events,
  runStatus,
  eventsTruncated,
  now,
}: {
  events: RunEvent[];
  runStatus: TriggerRunStatus;
  eventsTruncated?: boolean;
  /** The clock a still-running event is drawn to. Defaults to the wall clock. */
  now?: number;
}) => {
  const layout = useMemo(
    () => layoutTimeline(events, runStatus, now),
    [events, runStatus, now],
  );

  if (layout.rows.length === 0) {
    return (
      <EmptyCard
        icon={<ListTree />}
        title="No timeline"
        description={RUN_TIMELINE_EMPTY_NOTICE}
      />
    );
  }

  return (
    <div className="border rounded-lg overflow-hidden">
      <div className="grid grid-cols-[minmax(0,14rem)_1fr] md:grid-cols-[minmax(0,18rem)_1fr] items-center border-b bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground">
        <span>Event</span>
        <span className="flex justify-between">
          <span>0s</span>
          <span>{formatToolDuration(layout.totalMs)}</span>
        </span>
      </div>
      <ol className="divide-y">
        {layout.rows.map((row) => (
          <li
            key={row.event.id}
            className="grid grid-cols-[minmax(0,14rem)_1fr] md:grid-cols-[minmax(0,18rem)_1fr] items-center px-3"
            data-depth={row.depth}
          >
            <div
              className="min-w-0"
              style={{ paddingLeft: `${row.depth * 1.25}rem` }}
            >
              <ActivityRow
                entry={{
                  type: row.event.type,
                  toolName: row.event.toolName,
                  status: row.event.status,
                  error: row.event.error?.message
                    ? row.event.error.truncated
                      ? `${row.event.error.message}… (truncated)`
                      : row.event.error.message
                    : undefined,
                }}
                trailing={
                  row.end.kind === "known" ? (
                    <span className="text-xs text-muted-foreground shrink-0">
                      {formatToolDuration(row.end.durationMs)}
                    </span>
                  ) : undefined
                }
              />
              {row.event.childrenTruncated && (
                <p className="ml-5.5 mb-1 text-xs text-muted-foreground flex items-center gap-1">
                  <TriangleAlert className="size-3" />
                  Later events beneath this one were not recorded.
                </p>
              )}
            </div>
            <div className="relative h-6" aria-hidden={false}>
              <Bar row={row} totalMs={layout.totalMs} />
            </div>
          </li>
        ))}
      </ol>
      {eventsTruncated && (
        <TurnNotice className="m-3">{RUN_TIMELINE_TRUNCATED_NOTICE}</TurnNotice>
      )}
    </div>
  );
};
