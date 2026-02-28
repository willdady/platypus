"use client";

import { use } from "react";
import { CronJobForm } from "@/components/cron-job-form";
import { BackButton } from "@/components/back-button";

const CreateCronJobPage = ({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string }>;
}) => {
  const { orgId, workspaceId } = use(params);

  return (
    <div className="flex justify-center pb-8">
      <div className="xl:w-2/5">
        <BackButton
          fallbackHref={`/${orgId}/workspace/${workspaceId}/cron-jobs`}
        />
        <h1 className="text-2xl mb-4 font-bold">New Schedule</h1>
        <CronJobForm orgId={orgId} workspaceId={workspaceId} />
      </div>
    </div>
  );
};

export default CreateCronJobPage;
