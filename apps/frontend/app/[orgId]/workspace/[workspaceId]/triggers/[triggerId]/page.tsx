"use client";

import { use } from "react";
import { TriggerForm } from "@/components/trigger-form";
import { ResourcePage } from "@/components/resource-page";
import { workspaceRoutes } from "@/lib/routes";

const EditTriggerPage = ({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string; triggerId: string }>;
}) => {
  const { orgId, workspaceId, triggerId } = use(params);

  return (
    <ResourcePage
      backFallbackHref={workspaceRoutes(orgId, workspaceId).root}
      title="Edit Trigger"
      variant="narrow"
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
