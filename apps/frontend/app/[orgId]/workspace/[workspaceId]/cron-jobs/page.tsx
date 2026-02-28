"use client";

import { use } from "react";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";
import { type CronJob } from "@platypus/schemas";
import useSWR, { useSWRConfig } from "swr";
import { fetcher, joinUrl } from "@/lib/utils";
import Link from "next/link";
import { useBackendUrl } from "@/app/client-context";
import { useAuth } from "@/components/auth-provider";
import { CronJobList } from "@/components/cron-job-list";

const CronJobsPage = ({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string }>;
}) => {
  const { orgId, workspaceId } = use(params);

  const { user } = useAuth();
  const backendUrl = useBackendUrl();
  const { mutate } = useSWRConfig();

  const { data: cronJobsData, isLoading } = useSWR<{ results: CronJob[] }>(
    backendUrl && user
      ? joinUrl(
          backendUrl,
          `/organizations/${orgId}/workspaces/${workspaceId}/cron-jobs`,
        )
      : null,
    fetcher,
  );

  const cronJobs = cronJobsData?.results || [];

  if (isLoading) {
    return <div>Loading...</div>;
  }

  return (
    <div className="flex justify-center pb-8">
      <div className="w-full xl:w-4/5 max-w-4xl">
        <div className="flex justify-between items-center mb-6">
          <h1 className="text-2xl font-bold">Schedules</h1>
          <Button asChild>
            <Link href={`/${orgId}/workspace/${workspaceId}/cron-jobs/create`}>
              <Plus /> New Schedule
            </Link>
          </Button>
        </div>

        {cronJobs.length === 0 ? (
          <div className="text-center text-muted-foreground py-12">
            <p>No schedules configured.</p>
            <p className="text-sm mt-2">
              Create a schedule to run agents automatically at specific times.
            </p>
          </div>
        ) : (
          <CronJobList
            orgId={orgId}
            workspaceId={workspaceId}
            cronJobs={cronJobs}
            onMutate={() =>
              mutate(
                joinUrl(
                  backendUrl,
                  `/organizations/${orgId}/workspaces/${workspaceId}/cron-jobs`,
                ),
              )
            }
          />
        )}
      </div>
    </div>
  );
};

export default CronJobsPage;
