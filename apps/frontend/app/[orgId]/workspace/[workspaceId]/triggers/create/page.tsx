"use client";

import { use } from "react";
import { TriggerForm } from "@/components/trigger-form";
import { ResourcePage } from "@/components/resource-page";
import { workspaceRoutes } from "@/lib/routes";

const CreateTriggerPage = ({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string }>;
}) => {
  const { orgId, workspaceId } = use(params);

  return (
    <ResourcePage
      backFallbackHref={workspaceRoutes(orgId, workspaceId).root}
      title="New Trigger"
      variant="narrow"
    >
      <TriggerForm orgId={orgId} workspaceId={workspaceId} />
    </ResourcePage>
  );
};

export default CreateTriggerPage;
