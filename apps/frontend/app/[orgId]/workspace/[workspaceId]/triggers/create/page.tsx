"use client";

import { use } from "react";
import { TriggerForm } from "@/components/trigger-form";
import { BackButton } from "@/components/back-button";

const CreateTriggerPage = ({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string }>;
}) => {
  const { orgId, workspaceId } = use(params);

  return (
    <div className="flex justify-center pb-8">
      <div className="w-full px-4 md:px-0 md:w-4/5 xl:w-2/5">
        <BackButton
          fallbackHref={`/${orgId}/workspace/${workspaceId}`}
        />
        <h1 className="text-2xl mb-4 font-bold">New Trigger</h1>
        <TriggerForm orgId={orgId} workspaceId={workspaceId} />
      </div>
    </div>
  );
};

export default CreateTriggerPage;
