"use client";

import { use } from "react";
import { TriggerForm } from "@/components/trigger-form";
import { ResourcePage } from "@/components/resource-page";

const CreateTriggerPage = ({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string }>;
}) => {
  const { orgId, workspaceId } = use(params);

  return (
    <ResourcePage
      backFallbackHref={`/${orgId}/workspace/${workspaceId}`}
      title="New Trigger"
      variant="create"
    >
      <TriggerForm orgId={orgId} workspaceId={workspaceId} />
    </ResourcePage>
  );
};

export default CreateTriggerPage;
