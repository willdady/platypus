"use client";

import { use } from "react";
import { ScheduleForm } from "@/components/schedule-form";
import { BackButton } from "@/components/back-button";

const CreateSchedulePage = ({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string }>;
}) => {
  const { orgId, workspaceId } = use(params);

  return (
    <div className="flex justify-center pb-8">
      <div className="xl:w-2/5">
        <BackButton
          fallbackHref={`/${orgId}/workspace/${workspaceId}/schedules`}
        />
        <h1 className="text-2xl mb-4 font-bold">New Schedule</h1>
        <ScheduleForm orgId={orgId} workspaceId={workspaceId} />
      </div>
    </div>
  );
};

export default CreateSchedulePage;
