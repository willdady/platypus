"use client";

import { use } from "react";
import { BackButton } from "@/components/back-button";
import {
  type Trigger,
  type TriggerRun,
  type TriggerRunStats,
} from "@platypus/schemas";
import useSWR from "swr";
import { fetcher, joinUrl } from "@/lib/utils";
import { formatTokens } from "@/lib/context-window";
import { useBackendUrl } from "@/app/client-context";
import { useAuth } from "@/components/auth-provider";
import { format, formatDistanceToNow } from "date-fns";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Loader2,
  Footprints,
  Wrench,
  MessageSquare,
  Gauge,
  Copy,
} from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import {
  RunCutShortNotice,
  RunStepLimitNotice,
} from "@/components/run-cut-short-notice";
import { toast } from "sonner";

const TriggerRunsPage = ({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string; triggerId: string }>;
}) => {
  const { orgId, workspaceId, triggerId } = use(params);

  const { user } = useAuth();
  const backendUrl = useBackendUrl();

  const { data: trigger, isLoading: isLoadingTrigger } = useSWR<Trigger>(
    backendUrl && user
      ? joinUrl(
          backendUrl,
          `/organizations/${orgId}/workspaces/${workspaceId}/triggers/${triggerId}`,
        )
      : null,
    fetcher,
  );

  const { data: runsData, isLoading: isLoadingRuns } = useSWR<{
    results: TriggerRun[];
  }>(
    backendUrl && user
      ? joinUrl(
          backendUrl,
          `/organizations/${orgId}/workspaces/${workspaceId}/triggers/${triggerId}/runs`,
        )
      : null,
    fetcher,
  );

  const runs = runsData?.results || [];
  const isLoading = isLoadingTrigger || isLoadingRuns;

  const getStatusBadge = (status: TriggerRun["status"]) => {
    switch (status) {
      case "success":
        return <Badge variant="default">Success</Badge>;
      case "failed":
        return <Badge variant="destructive">Failed</Badge>;
      case "running":
        return (
          <Badge variant="secondary">
            <Loader2 className="w-3 h-3 mr-1 animate-spin" />
            Running
          </Badge>
        );
      case "pending":
      default:
        return <Badge variant="outline">Pending</Badge>;
    }
  };

  const getDuration = (run: TriggerRun) => {
    if (!run.completedAt) return null;
    const ms =
      new Date(run.completedAt).getTime() - new Date(run.startedAt).getTime();
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${(ms / 60000).toFixed(1)}m`;
  };

  const handleCopyRunId = async (runId: string) => {
    try {
      await navigator.clipboard.writeText(runId);
      toast.success("Copied to clipboard");
    } catch {
      toast.error("Failed to copy to clipboard");
    }
  };

  return (
    <div className="flex justify-center pb-8">
      <div className="w-full px-4 md:px-0 xl:w-4/5 max-w-4xl">
        <BackButton
          fallbackHref={`/${orgId}/workspace/${workspaceId}/triggers/${triggerId}`}
        />
        {isLoading ? (
          <>
            <Skeleton className="h-8 w-48 mb-1" />
            <Skeleton className="h-4 w-64 mb-4" />
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
          </>
        ) : (
          <>
            <h1 className="text-2xl mb-1 font-bold">{trigger?.name}</h1>
            {trigger?.description ? (
              <p className="text-muted-foreground mb-4">
                {trigger.description}
              </p>
            ) : (
              <div className="mb-4" />
            )}
            {runs.length === 0 ? (
              <p className="text-muted-foreground">
                No runs yet. Runs will appear here after the trigger fires.
              </p>
            ) : (
              <div className="border rounded-lg divide-y">
                {runs.map((run) => {
                  const stats = run.stats as TriggerRunStats | null | undefined;
                  return (
                    <div key={run.id} className="p-4">
                      <div className="flex items-center gap-4 justify-between">
                        <div className="flex items-center gap-4">
                          {getStatusBadge(run.status)}
                          <div>
                            <p className="font-medium">
                              {format(new Date(run.startedAt), "PPp")}
                            </p>
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
                                Duration: {getDuration(run)}
                              </p>
                            )}
                            {stats && (
                              <div className="flex gap-3 mt-1 text-xs text-muted-foreground">
                                <span className="flex items-center gap-1">
                                  <Footprints className="h-3 w-3" />
                                  {stats.steps} step
                                  {stats.steps !== 1 ? "s" : ""}
                                </span>
                                {stats.toolCalls.length > 0 ? (
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <span className="flex items-center gap-1 cursor-default">
                                        <Wrench className="h-3 w-3" />
                                        {stats.toolCalls.reduce(
                                          (sum, tc) => sum + tc.count,
                                          0,
                                        )}{" "}
                                        tool call
                                        {stats.toolCalls.reduce(
                                          (sum, tc) => sum + tc.count,
                                          0,
                                        ) !== 1
                                          ? "s"
                                          : ""}
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
                                <span className="flex items-center gap-1">
                                  <MessageSquare className="h-3 w-3" />
                                  {formatTokens(stats.inputTokens)} in /{" "}
                                  {formatTokens(stats.outputTokens)} out
                                </span>
                                {/* How full the context got on the run's LAST
                                  step, which is a different quantity from the
                                  cross-step sums above (ADR-0018). Absent where
                                  the Provider reported no usage — occupancy is
                                  then unknown and nothing is estimated. */}
                                {stats.contextOccupancy !== undefined && (
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <span className="flex items-center gap-1 cursor-default">
                                        <Gauge className="h-3 w-3" />
                                        {formatTokens(
                                          stats.contextOccupancy,
                                        )}{" "}
                                        context
                                      </span>
                                    </TooltipTrigger>
                                    <TooltipContent>
                                      Tokens the conversation filled on the
                                      final step
                                    </TooltipContent>
                                  </Tooltip>
                                )}
                              </div>
                            )}
                            {stats?.truncatedByTokenLimit && (
                              <RunCutShortNotice />
                            )}
                            {stats?.stoppedAtStepLimit && (
                              <RunStepLimitNotice />
                            )}
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
                              onClick={() => handleCopyRunId(run.id)}
                            >
                              <Copy className="h-4 w-4" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>Copy run id</TooltipContent>
                        </Tooltip>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
};

export default TriggerRunsPage;
