"use client";

import Link from "next/link";
import { format } from "date-fns";
import {
  Ban,
  Copy,
  Database,
  Footprints,
  Gauge,
  ListTree,
  Loader2,
  MessageSquare,
  Wrench,
} from "lucide-react";
import { toast } from "sonner";
import {
  TRIGGER_RUN_STATUS_LABELS,
  type TriggerRunStats,
  type TriggerRunStatus,
  type TriggerRunWithTrigger,
} from "@platypus/schemas";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  RunCutShortNotice,
  RunStepLimitNotice,
} from "@/components/run-cut-short-notice";
import { TurnNotice } from "@/components/turn-notice";
import { cachedTokenBreakdown } from "@/lib/cached-tokens";
import { formatTokens } from "@/lib/context-window";
import { formatRelativeTime } from "@/lib/relative-time";
import { workspaceRoutes } from "@/lib/routes";

/**
 * What the runs list says about a firing the run-rate breaker dropped before it
 * started. A constant so tests assert the wording without restating the prose.
 */
export const RUN_SUPPRESSED_NOTICE =
  "Suppressed: this trigger ran too often for this record, so no Agent was started.";

const statusBadge = (status: TriggerRunStatus) => {
  switch (status) {
    case "success":
      return (
        <Badge variant="default">{TRIGGER_RUN_STATUS_LABELS.success}</Badge>
      );
    case "failed":
      return (
        <Badge variant="destructive">{TRIGGER_RUN_STATUS_LABELS.failed}</Badge>
      );
    case "running":
      return (
        <Badge variant="secondary">
          <Loader2 className="w-3 h-3 mr-1 animate-spin" />
          {TRIGGER_RUN_STATUS_LABELS.running}
        </Badge>
      );
    // Not a failure: someone stopped it, nothing faulted (#647). Drawn in the
    // neutral variant so it never reads as a crash.
    case "cancelled":
      return (
        <Badge variant="outline">
          <Ban className="w-3 h-3 mr-1" />
          {TRIGGER_RUN_STATUS_LABELS.cancelled}
        </Badge>
      );
    case "suppressed":
      return (
        <Badge variant="destructive">
          <Ban className="w-3 h-3 mr-1" />
          {TRIGGER_RUN_STATUS_LABELS.suppressed}
        </Badge>
      );
    case "pending":
    default:
      return (
        <Badge variant="outline">{TRIGGER_RUN_STATUS_LABELS.pending}</Badge>
      );
  }
};

/** The run detail page's address, where the list's rows lead. */
export const triggerRunDetailHref = (
  orgId: string,
  workspaceId: string,
  runId: string,
) => workspaceRoutes(orgId, workspaceId).triggerRuns.detail(runId);

const formatDuration = (run: TriggerRunWithTrigger) => {
  if (!run.completedAt) return null;
  const ms =
    new Date(run.completedAt).getTime() - new Date(run.startedAt).getTime();
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
};

/**
 * One run in the workspace-wide Trigger runs list. The list mixes runs from
 * every Trigger, so the row names — and links to — the Trigger it came from;
 * everything else is the per-run detail an Operator already reads. The same
 * row heads the run detail page, which turns `linkToDetail` off so the row
 * does not offer a link to the page it is already on.
 */
export const TriggerRunRow = ({
  run,
  orgId,
  workspaceId,
  linkToDetail = true,
}: {
  run: TriggerRunWithTrigger;
  orgId: string;
  workspaceId: string;
  /** Whether the row offers **View run**. Off on the run's own page. */
  linkToDetail?: boolean;
}) => {
  const stats = run.stats as TriggerRunStats | null | undefined;

  const handleCopyRunId = async () => {
    try {
      await navigator.clipboard.writeText(run.id);
      toast.success("Copied to clipboard");
    } catch {
      toast.error("Failed to copy to clipboard");
    }
  };

  const toolCallCount =
    stats?.toolCalls.reduce((sum, tc) => sum + tc.count, 0) ?? 0;

  return (
    <div className="p-4">
      <div className="flex items-center gap-4 justify-between">
        {/* `min-w-0` down the left column: a flex item's minimum is otherwise
          its content's, so a long Trigger name, an error message or the stats
          line would widen the column past the row and push the actions off
          the right edge on a phone. */}
        <div className="flex min-w-0 items-center gap-4">
          {statusBadge(run.status)}
          <div className="min-w-0">
            <Link
              className="font-medium hover:underline break-words"
              href={workspaceRoutes(orgId, workspaceId).triggers.detail(
                run.triggerId,
              )}
            >
              {run.triggerName}
            </Link>
            <p className="text-sm">{format(new Date(run.startedAt), "PPp")}</p>
            <p className="text-sm text-muted-foreground">
              {formatRelativeTime(run.startedAt)}
            </p>
            {run.eventType && (
              <p className="text-sm text-muted-foreground">
                Event: {run.eventType}
              </p>
            )}
            {run.completedAt && (
              <p className="text-sm text-muted-foreground">
                Duration: {formatDuration(run)}
              </p>
            )}
            {stats && (
              <div className="flex flex-wrap gap-x-3 gap-y-1 mt-1 text-xs text-muted-foreground">
                <span className="flex items-center gap-1 whitespace-nowrap">
                  <Footprints className="h-3 w-3" />
                  {stats.steps} step{stats.steps !== 1 ? "s" : ""}
                </span>
                {stats.toolCalls.length > 0 ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="flex items-center gap-1 cursor-default whitespace-nowrap">
                        <Wrench className="h-3 w-3" />
                        {toolCallCount} tool call
                        {toolCallCount !== 1 ? "s" : ""}
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>
                      <ul className="text-left">
                        {stats.toolCalls.map((tc) => (
                          <li key={tc.name}>
                            {tc.name} &times;{tc.count}
                          </li>
                        ))}
                      </ul>
                    </TooltipContent>
                  </Tooltip>
                ) : (
                  <span className="flex items-center gap-1 whitespace-nowrap">
                    <Wrench className="h-3 w-3" />0 tool calls
                  </span>
                )}
                {/* Cached input is a breakdown of the in figure above, which
                  already includes it — never subtracted (issue #734). A tooltip
                  on a cache icon so the token line stays as tight as it was:
                  absent means the Provider reported no cache detail, which is
                  never rendered as zero. */}
                {stats.cacheReadTokens !== undefined ||
                stats.cacheWriteTokens !== undefined ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="flex items-center gap-1 cursor-default whitespace-nowrap">
                        <MessageSquare className="h-3 w-3" />
                        {formatTokens(stats.inputTokens)} in /{" "}
                        {formatTokens(stats.outputTokens)} out
                        <Database className="h-3 w-3 text-muted-foreground" />
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>
                      <ul className="text-left">
                        {cachedTokenBreakdown(stats, formatTokens).map(
                          (line) => (
                            <li key={line}>{line}</li>
                          ),
                        )}
                      </ul>
                    </TooltipContent>
                  </Tooltip>
                ) : (
                  <span className="flex items-center gap-1 whitespace-nowrap">
                    <MessageSquare className="h-3 w-3" />
                    {formatTokens(stats.inputTokens)} in /{" "}
                    {formatTokens(stats.outputTokens)} out
                  </span>
                )}
                {/* How full the context got on the run's LAST step, which is a
                  different quantity from the cross-step sums above (ADR-0018).
                  Absent where the Provider reported no usage — occupancy is
                  then unknown and nothing is estimated. */}
                {stats.contextOccupancy !== undefined && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="flex items-center gap-1 cursor-default whitespace-nowrap">
                        <Gauge className="h-3 w-3" />
                        {formatTokens(stats.contextOccupancy)} context
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>
                      Tokens the conversation filled on the final step
                    </TooltipContent>
                  </Tooltip>
                )}
              </div>
            )}
            {stats?.truncatedByTokenLimit && <RunCutShortNotice />}
            {stats?.stoppedAtStepLimit && <RunStepLimitNotice />}
            {run.status === "suppressed" && (
              <TurnNotice className="mt-1">{RUN_SUPPRESSED_NOTICE}</TurnNotice>
            )}
            {run.errorMessage && (
              <p className="text-sm text-destructive mt-1 break-words">
                {run.errorMessage}
              </p>
            )}
          </div>
        </div>
        <div className="flex items-center shrink-0">
          {/* A suppressed firing never ran, so it has no timeline to open. */}
          {linkToDetail && run.status !== "suppressed" && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  className="text-muted-foreground"
                  variant="ghost"
                  size="icon"
                  aria-label="View run"
                  asChild
                >
                  <Link href={triggerRunDetailHref(orgId, workspaceId, run.id)}>
                    <ListTree className="h-4 w-4" />
                  </Link>
                </Button>
              </TooltipTrigger>
              <TooltipContent>View run</TooltipContent>
            </Tooltip>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                className="text-muted-foreground"
                variant="ghost"
                size="icon"
                aria-label="Copy run id"
                onClick={handleCopyRunId}
              >
                <Copy className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Copy run id</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </div>
  );
};
