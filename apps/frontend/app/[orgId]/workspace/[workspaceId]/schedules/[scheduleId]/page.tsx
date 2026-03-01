"use client";

import { use } from "react";
import { ScheduleForm } from "@/components/schedule-form";
import { BackButton } from "@/components/back-button";

const EditSchedulePage = ({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string; scheduleId: string }>;
}) => {
  const { orgId, workspaceId, scheduleId } = use(params);

  return (
    <div className="flex justify-center pb-8">
      <div className="w-full xl:w-4/5 max-w-4xl">
        <BackButton
          fallbackHref={`/${orgId}/workspace/${workspaceId}/schedules`}
        />
        <h1 className="text-2xl mb-4 font-bold">Edit Schedule</h1>
        <ScheduleForm
          orgId={orgId}
          workspaceId={workspaceId}
          scheduleId={scheduleId}
        />
      </div>
    </div>
  );
};

export default EditSchedulePage;
