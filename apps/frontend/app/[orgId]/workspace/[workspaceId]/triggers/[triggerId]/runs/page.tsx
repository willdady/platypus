"use client";

import { use } from "react";
import { BackButton } from "@/components/back-button";
import { type Trigger, type TriggerRun } from "@platypus/schemas";
import useSWR from "swr";
import { fetcher, joinUrl } from "@/lib/utils";
import Link from "next/link";
import { useBackendUrl } from "@/app/client-context";
import { useAuth } from "@/components/auth-provider";
import { format, formatDistanceToNow } from "date-fns";
import { Badge } from "@/components/ui/badge";
import { Loader2 } from "lucide-react";

const TriggerRunsPage = ({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string; triggerId: string }>;
}) => {
  const { orgId, workspaceId, triggerId } = use(params);

  const { user } = useAuth();
  const backendUrl = useBackendUrl();

  const { data: trigger } = useSWR<Trigger>(
    backendUrl && user
      ? joinUrl(
          backendUrl,
          `/organizations/${orgId}/workspaces/${workspaceId}/triggers/${triggerId}`,
        )
      : null,
    fetcher,
  );

  const { data: runsData, isLoading } = useSWR<{ results: TriggerRun[] }>(
    backendUrl && user
      ? joinUrl(
          backendUrl,
          `/organizations/${orgId}/workspaces/${workspaceId}/triggers/${triggerId}/runs`,
        )
      : null,
    fetcher,
  );

  const runs = runsData?.results || [];

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

  return (
    <div className="flex justify-center pb-8">
      <div className="w-full xl:w-4/5 max-w-4xl">
        <BackButton
          fallbackHref={`/${orgId}/workspace/${workspaceId}/triggers/${triggerId}`}
        />
        <h1 className="text-2xl mb-1 font-bold">
          {trigger ? trigger.name : "Run History"}
        </h1>
        {trigger?.description && (
          <p className="text-muted-foreground mb-4">{trigger.description}</p>
        )}
        {!trigger?.description && <div className="mb-4" />}

        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        ) : runs.length === 0 ? (
          <p className="text-muted-foreground">
            No runs yet. Runs will appear here after the trigger fires.
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

export default TriggerRunsPage;
