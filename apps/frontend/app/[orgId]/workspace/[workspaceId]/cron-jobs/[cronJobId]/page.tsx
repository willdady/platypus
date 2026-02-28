"use client";

import { use } from "react";
import { CronJobForm } from "@/components/cron-job-form";
import { BackButton } from "@/components/back-button";
import { type Chat } from "@platypus/schemas";
import useSWR from "swr";
import { fetcher, joinUrl } from "@/lib/utils";
import Link from "next/link";
import { useBackendUrl } from "@/app/client-context";
import { useAuth } from "@/components/auth-provider";
import { format } from "date-fns";

const EditCronJobPage = ({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string; cronJobId: string }>;
}) => {
  const { orgId, workspaceId, cronJobId } = use(params);

  const { user } = useAuth();
  const backendUrl = useBackendUrl();

  // Fetch chats for this cron job
  const { data: chatsData, isLoading: chatsLoading } = useSWR<{
    results: Chat[];
  }>(
    backendUrl && user
      ? joinUrl(
          backendUrl,
          `/organizations/${orgId}/workspaces/${workspaceId}/cron-jobs/${cronJobId}/chats`,
        )
      : null,
    fetcher,
  );

  const chats = chatsData?.results || [];

  return (
    <div className="flex justify-center pb-8">
      <div className="w-full xl:w-4/5 max-w-4xl">
        <BackButton
          fallbackHref={`/${orgId}/workspace/${workspaceId}/cron-jobs`}
        />
        <h1 className="text-2xl mb-4 font-bold">Edit Schedule</h1>
        <CronJobForm
          orgId={orgId}
          workspaceId={workspaceId}
          cronJobId={cronJobId}
        />

        {/* Run History */}
        <div className="mt-8">
          <h2 className="text-xl font-semibold mb-4">Run History</h2>
          {chatsLoading ? (
            <div>Loading...</div>
          ) : chats.length === 0 ? (
            <p className="text-muted-foreground">
              No runs yet. The schedule will appear here after it runs.
            </p>
          ) : (
            <div className="border rounded-lg divide-y">
              {chats.map((chat) => (
                <Link
                  key={chat.id}
                  href={`/${orgId}/workspace/${workspaceId}/chat/${chat.id}`}
                  className="flex justify-between items-center p-3 hover:bg-muted/50 transition-colors"
                >
                  <div>
                    <p className="font-medium">{chat.title}</p>
                    <p className="text-sm text-muted-foreground">
                      {format(new Date(chat.createdAt), "PPp")}
                    </p>
                  </div>
                  <span className="text-sm text-muted-foreground">View</span>
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default EditCronJobPage;
