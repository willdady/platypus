"use client";

import Link from "next/link";
import { format, formatDistanceToNow } from "date-fns";
import {
  Copy,
  Database,
  Footprints,
  Gauge,
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
import { cachedTokenBreakdown } from "@/lib/cached-tokens";
import { formatTokens } from "@/lib/context-window";

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
    case "pending":
    default:
      return (
        <Badge variant="outline">{TRIGGER_RUN_STATUS_LABELS.pending}</Badge>
      );
  }
};

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
 * everything else is the per-run detail an Operator already reads.
 */
export const TriggerRunRow = ({
  run,
  orgId,
  workspaceId,
}: {
  run: TriggerRunWithTrigger;
  orgId: string;
  workspaceId: string;
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
        <div className="flex items-center gap-4">
          {statusBadge(run.status)}
          <div>
            <Link
              className="font-medium hover:underline"
              href={`/${orgId}/workspace/${workspaceId}/triggers/${run.triggerId}`}
            >
              {run.triggerName}
            </Link>
            <p className="text-sm">{format(new Date(run.startedAt), "PPp")}</p>
            <p className="text-sm text-muted-foreground">
              {formatDistanceToNow(new Date(run.startedAt), {
                addSuffix: true,
              })}
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
              <div className="flex gap-3 mt-1 text-xs text-muted-foreground">
                <span className="flex items-center gap-1">
                  <Footprints className="h-3 w-3" />
                  {stats.steps} step{stats.steps !== 1 ? "s" : ""}
                </span>
                {stats.toolCalls.length > 0 ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="flex items-center gap-1 cursor-default">
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
                  <span className="flex items-center gap-1">
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
                      <span className="flex items-center gap-1 cursor-default">
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
                  <span className="flex items-center gap-1">
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
                      <span className="flex items-center gap-1 cursor-default">
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
            {run.errorMessage && (
              <p className="text-sm text-destructive mt-1">
                {run.errorMessage}
              </p>
            )}
          </div>
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              className="text-muted-foreground shrink-0"
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
  );
};
