"use client";

import { use } from "react";
import { BackButton } from "@/components/back-button";
import { type Schedule, type ScheduleRun } from "@platypus/schemas";
import useSWR from "swr";
import { fetcher, joinUrl } from "@/lib/utils";
import Link from "next/link";
import { useBackendUrl } from "@/app/client-context";
import { useAuth } from "@/components/auth-provider";
import { format, formatDistanceToNow } from "date-fns";
import { Badge } from "@/components/ui/badge";
import { Loader2 } from "lucide-react";

const ScheduleRunsPage = ({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string; scheduleId: string }>;
}) => {
  const { orgId, workspaceId, scheduleId } = use(params);

  const { user } = useAuth();
  const backendUrl = useBackendUrl();

  // Fetch schedule details
  const { data: schedule } = useSWR<Schedule>(
    backendUrl && user
      ? joinUrl(
          backendUrl,
          `/organizations/${orgId}/workspaces/${workspaceId}/schedules/${scheduleId}`,
        )
      : null,
    fetcher,
  );

  // Fetch runs for this schedule
  const { data: runsData, isLoading } = useSWR<{ results: ScheduleRun[] }>(
    backendUrl && user
      ? joinUrl(
          backendUrl,
          `/organizations/${orgId}/workspaces/${workspaceId}/schedules/${scheduleId}/runs`,
        )
      : null,
    fetcher,
  );

  const runs = runsData?.results || [];

  const getStatusBadge = (status: ScheduleRun["status"]) => {
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

  const getDuration = (run: ScheduleRun) => {
    if (!run.completedAt) return null;
    const ms =
      new Date(run.completedAt).getTime() - new Date(run.startedAt).getTime();
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${(ms / 60000).toFixed(1)}m`;
  };

  return (
    <div className="flex justify-center pb-8">
      <div className="w-full xl:w-4/5 max-w-4xl">
        <BackButton
          fallbackHref={`/${orgId}/workspace/${workspaceId}/schedules/${scheduleId}`}
        />
        <h1 className="text-2xl mb-1 font-bold">
          {schedule ? schedule.name : "Run History"}
        </h1>
        {schedule?.description && (
          <p className="text-muted-foreground mb-4">{schedule.description}</p>
        )}
        {!schedule?.description && <div className="mb-4" />}

        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        ) : runs.length === 0 ? (
          <p className="text-muted-foreground">
            No runs yet. The schedule will appear here after it runs.
          </p>
        ) : (
          <div className="border rounded-lg divide-y">
            {runs.map((run) => (
              <div
                key={run.id}
                className="flex justify-between items-center p-4"
              >
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
                    {run.completedAt && (
                      <p className="text-sm text-muted-foreground">
                        Duration: {getDuration(run)}
                      </p>
                    )}
                    {run.errorMessage && (
                      <p className="text-sm text-destructive mt-1">
                        {run.errorMessage}
                      </p>
                    )}
                  </div>
                </div>
                {run.chatId && (
                  <Link
                    href={`/${orgId}/workspace/${workspaceId}/chat/${run.chatId}`}
                    className="text-sm text-primary hover:underline"
                  >
                    View chat
                  </Link>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default ScheduleRunsPage;
