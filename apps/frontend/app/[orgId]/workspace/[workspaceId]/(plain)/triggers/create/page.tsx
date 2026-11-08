import type { Metadata } from "next";
import { TriggerForm } from "@/components/trigger-form";
import { ResourcePage } from "@/components/resource-page";

export const metadata: Metadata = { title: "Create Trigger" };

async function CreateTriggerPage({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string }>;
}) {
  const { orgId, workspaceId } = await params;

  return (
    <ResourcePage title="Create Trigger" variant="narrow">
      <TriggerForm orgId={orgId} workspaceId={workspaceId} />
    </ResourcePage>
  );
}

export default CreateTriggerPage;
