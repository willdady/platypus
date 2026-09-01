"use client";

import { use } from "react";
import { TriggerForm } from "@/components/trigger-form";
import { ResourcePage } from "@/components/resource-page";

const EditTriggerPage = ({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string; triggerId: string }>;
}) => {
  const { orgId, workspaceId, triggerId } = use(params);

  return (
    <ResourcePage
      backFallbackHref={`/${orgId}/workspace/${workspaceId}`}
      title="Edit Trigger"
      variant="create"
    >
      <TriggerForm
        orgId={orgId}
        workspaceId={workspaceId}
        triggerId={triggerId}
      />
    </ResourcePage>
  );
};

export default EditTriggerPage;
