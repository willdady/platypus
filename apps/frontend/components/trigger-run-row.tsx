"use client";

import Link from "next/link";
import { formatDateTime } from "@/lib/format-date";
import { formatToolDuration } from "@/lib/tool-duration";
import {
  Ban,
  CircleCheck,
  CircleX,
  Clock,
  Copy,
  Database,
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
  type TriggerRunStatus,
  type TriggerRunWithTrigger,
  type UnloadedToolSet,
  type UnloadedToolSetReason,
} from "@platypus/schemas";
import { Badge } from "@/components/ui/badge";
import { RowActionsMenu } from "@/components/row-actions-menu";
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
import type { Serialized } from "@/lib/api-write";

export const RUN_SUPPRESSED_NOTICE =
  "Suppressed: this trigger ran too often for this record, so no Agent was started.";

export const RUN_WARNINGS_LABEL = "Run warnings";

export function fallbackNotice(from: string, to: string): string {
  return `Fell back from ${from} to ${to} after the primary Provider failed.`;
}

const UNLOADED_REASON_LABELS: Record<UnloadedToolSetReason, string> = {
  not_found: "not found",
  factory_failed: "its Plugin failed to build it",
  misconfigured: "misconfigured",
  unauthorized: "rejected its credentials",
  unreachable: "unreachable",
};

function unloadedToolSetNotice({ toolSetId, name, reason }: UnloadedToolSet) {
  return `'${name ?? toolSetId}' loaded no tools: ${UNLOADED_REASON_LABELS[reason]}`;
}

function failedToolCallsNotice(count: number) {
  return `${count} tool call${count !== 1 ? "s" : ""} failed`;
}

export function statusBadge(status: TriggerRunStatus) {
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
          <Loader2 className="size-3 mr-1 animate-spin" />
          {TRIGGER_RUN_STATUS_LABELS.running}
        </Badge>
      );
    case "cancelled":
      return (
        <Badge variant="outline">
          <Ban className="size-3 mr-1" />
          {TRIGGER_RUN_STATUS_LABELS.cancelled}
        </Badge>
      );
    case "suppressed":
      return (
        <Badge variant="destructive">
          <Ban className="size-3 mr-1" />
          {TRIGGER_RUN_STATUS_LABELS.suppressed}
        </Badge>
      );
    case "pending":
    default:
      return (
        <Badge variant="outline">{TRIGGER_RUN_STATUS_LABELS.pending}</Badge>
      );
  }
}

const STATUS_ICONS: Record<
  TriggerRunStatus,
  { icon: LucideIcon; className: string }
> = {
  success: { icon: CircleCheck, className: "text-success" },
  failed: { icon: CircleX, className: "text-destructive" },
  running: { icon: Loader2, className: "animate-spin" },
  cancelled: { icon: Ban, className: "" },
  suppressed: { icon: Ban, className: "text-destructive" },
  pending: { icon: Clock, className: "" },
};

export function StatusIcon({ status }: { status: TriggerRunStatus }) {
  const { icon: Icon, className } =
    STATUS_ICONS[status] ?? STATUS_ICONS.pending;
  const label = TRIGGER_RUN_STATUS_LABELS[status];
  // why: 1px down centres the icon on lowercase text
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className="flex translate-y-px"
    >
      <Icon className={cn("size-3", className)} />
    </span>
  );
}

export function triggerRunDetailHref(
  orgId: string,
  workspaceId: string,
  runId: string,
) {
  return workspaceRoutes(orgId, workspaceId).triggerRuns.detail(runId);
}

export function TriggerRunRow({
  run,
  orgId,
  workspaceId,
  linkToDetail = true,
}: {
  run: Serialized<TriggerRunWithTrigger>;
  orgId: string;
  workspaceId: string;
  linkToDetail?: boolean;
}) {
  const stats = run.stats;

  const routes = workspaceRoutes(orgId, workspaceId);
  const handleCopyRunId = () => void copyWithToast(run.id);
  const isLink = linkToDetail && run.status !== "suppressed";

  const toolCallCount =
    stats?.toolCalls.reduce((sum, tc) => sum + tc.count, 0) ?? 0;

  // why: min-w-0, or a long name pushes the actions off the right edge
  // why: cached input is a breakdown of the in figure, never subtracted
  // why: last step's occupancy, a different quantity from the cross-step sums
  const rowBody = (
    <div className="flex items-center gap-4 justify-between">
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
            Duration:{" "}
            {formatToolDuration(
              new Date(run.completedAt).getTime() -
                new Date(run.startedAt).getTime(),
            )}
          </p>
        )}
        {stats && (
          <div className="flex flex-wrap gap-x-3 gap-y-1 mt-1 text-xs text-muted-foreground">
            <span className="flex items-center gap-1 whitespace-nowrap">
              <Footprints className="size-3" />
              {stats.steps} step{stats.steps !== 1 ? "s" : ""}
            </span>
            {stats.toolCalls.length > 0 ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="flex items-center gap-1 cursor-default whitespace-nowrap">
                    <Wrench className="size-3" />
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
                <Wrench className="size-3" />0 tool calls
              </span>
            )}
            {stats.cacheReadTokens !== undefined ||
            stats.cacheWriteTokens !== undefined ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="flex items-center gap-1 cursor-default whitespace-nowrap">
                    <MessageSquare className="size-3" />
                    {formatTokens(stats.inputTokens)} in /{" "}
                    {formatTokens(stats.outputTokens)} out
                    <Database className="size-3 text-muted-foreground" />
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
                <MessageSquare className="size-3" />
                {formatTokens(stats.inputTokens)} in /{" "}
                {formatTokens(stats.outputTokens)} out
              </span>
            )}
            {stats.contextOccupancy !== undefined && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="flex items-center gap-1 cursor-default whitespace-nowrap">
                    <Gauge className="size-3" />
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
        {stats?.fallback && (
          <TurnNotice className="mt-1">
            {fallbackNotice(stats.fallback.from.model, stats.fallback.to.model)}
          </TurnNotice>
        )}
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
        <RowActionsMenu
          name={`${run.triggerName} run`}
          actions={[
            {
              label: "Edit trigger",
              icon: <Pencil />,
              href: routes.triggers.detail(run.triggerId),
            },
            ...(linkToDetail
              ? []
              : [
                  {
                    label: "View trigger's runs",
                    icon: <List />,
                    href: routes.triggerRuns.forTrigger(run.triggerId),
                  },
                ]),
            { label: "Copy run id", icon: <Copy />, onSelect: handleCopyRunId },
          ]}
        />
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
}
