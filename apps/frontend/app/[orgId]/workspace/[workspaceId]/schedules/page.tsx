"use client";

import { use } from "react";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";
import { type Schedule } from "@platypus/schemas";
import useSWR, { useSWRConfig } from "swr";
import { fetcher, joinUrl } from "@/lib/utils";
import Link from "next/link";
import { useBackendUrl } from "@/app/client-context";
import { useAuth } from "@/components/auth-provider";
import { ScheduleList } from "@/components/schedule-list";

const SchedulesPage = ({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string }>;
}) => {
  const { orgId, workspaceId } = use(params);

  const { user } = useAuth();
  const backendUrl = useBackendUrl();
  const { mutate } = useSWRConfig();

  const { data: schedulesData, isLoading } = useSWR<{ results: Schedule[] }>(
    backendUrl && user
      ? joinUrl(
          backendUrl,
          `/organizations/${orgId}/workspaces/${workspaceId}/schedules`,
        )
      : null,
    fetcher,
  );

  const schedules = schedulesData?.results || [];

  if (isLoading) {
    return <div>Loading...</div>;
  }

  return (
    <div className="flex justify-center pb-8">
      <div className="w-full xl:w-4/5 max-w-4xl">
        <div className="flex justify-between items-center mb-6">
          <h1 className="text-2xl font-bold">Schedules</h1>
          <Button asChild>
            <Link href={`/${orgId}/workspace/${workspaceId}/schedules/create`}>
              <Plus /> New Schedule
            </Link>
          </Button>
        </div>

        {schedules.length === 0 ? (
          <div className="text-center text-muted-foreground py-12">
            <p>No schedules configured.</p>
            <p className="text-sm mt-2">
              Create a schedule to run agents automatically at specific times.
            </p>
          </div>
        ) : (
          <ScheduleList
            orgId={orgId}
            workspaceId={workspaceId}
            schedules={schedules}
            onMutate={() =>
              mutate(
                joinUrl(
                  backendUrl,
                  `/organizations/${orgId}/workspaces/${workspaceId}/schedules`,
                ),
              )
            }
          />
        )}
      </div>
    </div>
  );
};

export default SchedulesPage;
