"use client";

import Link from "next/link";
import { formatDateTime } from "@/lib/format-date";
import {
  Ban,
  CircleCheck,
  CircleX,
  Clock,
  Copy,
  Database,
  EllipsisVertical,
  Footprints,
  Gauge,
  List,
  Loader2,
  MessageSquare,
  Pencil,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { copyWithToast } from "@/lib/clipboard";
import {
  TRIGGER_RUN_STATUS_LABELS,
  type TriggerRunStats,
  type TriggerRunStatus,
  type TriggerRunWithTrigger,
  type UnloadedToolSet,
  type UnloadedToolSetReason,
} from "@platypus/schemas";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  RUN_CUT_SHORT_NOTICE,
  RUN_STEP_LIMIT_NOTICE,
  TurnNotice,
} from "@/components/turn-notice";
import { cachedTokenBreakdown } from "@/lib/cached-tokens";
import { formatTokens } from "@/lib/context-window";
import { formatRelativeTime } from "@/lib/relative-time";
import { workspaceRoutes } from "@/lib/routes";
import { cn } from "@/lib/utils";

/**
 * What the runs list says about a firing the run-rate breaker dropped before it
 * started. A constant so tests assert the wording without restating the prose.
 */
export const RUN_SUPPRESSED_NOTICE =
  "Suppressed: this trigger ran too often for this record, so no Agent was started.";

/** The accessible name of a run's warnings, for tests to find them by. */
export const RUN_WARNINGS_LABEL = "Run warnings";

const UNLOADED_REASON_LABELS: Record<UnloadedToolSetReason, string> = {
  not_found: "not found",
  factory_failed: "its Plugin failed to build it",
  misconfigured: "misconfigured",
  unauthorized: "rejected its credentials",
  unreachable: "unreachable",
};

/**
 * One granted Tool set or MCP that served the run no tools (#1184), by its
 * display name — or its id when the id names nothing any more.
 */
const unloadedToolSetNotice = ({ toolSetId, name, reason }: UnloadedToolSet) =>
  `'${name ?? toolSetId}' loaded no tools: ${UNLOADED_REASON_LABELS[reason]}`;

const failedToolCallsNotice = (count: number) =>
  `${count} tool call${count !== 1 ? "s" : ""} failed`;

export const statusBadge = (status: TriggerRunStatus) => {
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

const STATUS_ICONS: Record<
  TriggerRunStatus,
  { icon: LucideIcon; className: string }
> = {
  success: { icon: CircleCheck, className: "text-green-600" },
  failed: { icon: CircleX, className: "text-destructive" },
  running: { icon: Loader2, className: "animate-spin" },
  // Neutral, like its badge: a cancel is not a crash (#647).
  cancelled: { icon: Ban, className: "" },
  suppressed: { icon: Ban, className: "text-destructive" },
  pending: { icon: Clock, className: "" },
};

/** A run status as a colored icon, named by its label, for tight spaces. */
export const StatusIcon = ({ status }: { status: TriggerRunStatus }) => {
  const { icon: Icon, className } =
    STATUS_ICONS[status] ?? STATUS_ICONS.pending;
  const label = TRIGGER_RUN_STATUS_LABELS[status];
  // translate-y-px: centered on the line box, the icon reads high beside
  // lowercase text; 1px down lines it up with the letters.
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className="flex translate-y-px"
    >
      <Icon className={cn("h-3 w-3", className)} />
    </span>
  );
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
 * every Trigger, so the row names the Trigger it came from; everything else is
 * the per-run detail an Operator already reads. In the list the whole row is
 * the link to the run, as a Workspace home Trigger card is to its Trigger, and
 * the ⋮ menu holds the rest. The same row heads the run detail page, which
 * turns `linkToDetail` off: the row is then no link, and its menu gains a way
 * back to the Trigger's other runs.
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
  /** Whether the row links to the run's page. Off on that page itself. */
  linkToDetail?: boolean;
}) => {
  const stats = run.stats as TriggerRunStats | null | undefined;

  const routes = workspaceRoutes(orgId, workspaceId);
  const handleCopyRunId = () => copyWithToast(run.id);
  // A suppressed firing never ran, so it has no timeline to open.
  const isLink = linkToDetail && run.status !== "suppressed";

  const toolCallCount =
    stats?.toolCalls.reduce((sum, tc) => sum + tc.count, 0) ?? 0;

  const rowBody = (
    <div className="flex items-center gap-4 justify-between">
      {/* Two columns: text, then actions. The badge sits under the name
          rather than in a column of its own, which squeezed the text on a
          phone (#1410). `min-w-0`: a flex item's minimum is otherwise its
          content's, so a long Trigger name, an error message or the stats
          line would widen the column past the row and push the actions off
          the right edge. */}
      <div className="min-w-0 flex-1">
        <p className="font-medium break-words">{run.triggerName}</p>
        <div className="my-1 flex">{statusBadge(run.status)}</div>
        <p className="text-sm">{formatDateTime(run.startedAt)}</p>
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
                    {cachedTokenBreakdown(stats, formatTokens).map((line) => (
                      <li key={line}>{line}</li>
                    ))}
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
        {stats?.truncatedByTokenLimit && (
          <TurnNotice className="mt-1">{RUN_CUT_SHORT_NOTICE}</TurnNotice>
        )}
        {stats?.stoppedAtStepLimit && (
          <TurnNotice className="mt-1">{RUN_STEP_LIMIT_NOTICE}</TurnNotice>
        )}
        {/* Warnings, never a status: a run that went without some of its
            tools, or whose tool calls failed, can still end `success`
            (#1184). Nothing extra for a clean run. */}
        {(run.unloadedToolSets.length > 0 || run.failedToolCalls > 0) && (
          <div role="group" aria-label={RUN_WARNINGS_LABEL}>
            {run.unloadedToolSets.map((unloaded) => (
              <TurnNotice key={unloaded.toolSetId} className="mt-1">
                {unloadedToolSetNotice(unloaded)}
              </TurnNotice>
            ))}
            {run.failedToolCalls > 0 && (
              <TurnNotice className="mt-1">
                {failedToolCallsNotice(run.failedToolCalls)}
              </TurnNotice>
            )}
          </div>
        )}
        {run.status === "suppressed" && (
          <TurnNotice className="mt-1">{RUN_SUPPRESSED_NOTICE}</TurnNotice>
        )}
        {run.errorMessage && (
          <p className="text-sm text-destructive mt-1 break-words">
            {run.errorMessage}
          </p>
        )}
      </div>
      <div className="flex items-center shrink-0">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              className="cursor-pointer text-muted-foreground"
              variant="ghost"
              size="icon"
              aria-label={`Actions for ${run.triggerName} run`}
              // Inside the row's link: opening the menu must not open the run.
              onClick={(e) => e.preventDefault()}
            >
              <EllipsisVertical className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          {/* Portalled, but React still bubbles its clicks to the row link. */}
          <DropdownMenuContent onClick={(e) => e.preventDefault()}>
            <DropdownMenuItem asChild>
              <Link
                className="cursor-pointer"
                href={routes.triggers.detail(run.triggerId)}
              >
                <Pencil /> Edit trigger
              </Link>
            </DropdownMenuItem>
            {!linkToDetail && (
              <DropdownMenuItem asChild>
                <Link
                  className="cursor-pointer"
                  href={routes.triggerRuns.forTrigger(run.triggerId)}
                >
                  <List /> View trigger&apos;s runs
                </Link>
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              className="cursor-pointer"
              onSelect={handleCopyRunId}
            >
              <Copy /> Copy run id
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );

  if (!isLink) {
    return <div className="p-4">{rowBody}</div>;
  }

  return (
    <Link
      className="block p-4 transition-colors hover:bg-accent/50"
      href={triggerRunDetailHref(orgId, workspaceId, run.id)}
    >
      {rowBody}
    </Link>
  );
};
