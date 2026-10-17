import type { Metadata } from "next";
import { TriggerForm } from "@/components/trigger-form";
import { ResourcePage } from "@/components/resource-page";
import { workspaceRoutes } from "@/lib/routes";

export const metadata: Metadata = { title: "New Trigger" };

async function CreateTriggerPage({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string }>;
}) {
  const { orgId, workspaceId } = await params;

  return (
    <ResourcePage
      backFallbackHref={workspaceRoutes(orgId, workspaceId).root}
      title="New Trigger"
      variant="narrow"
    >
      <TriggerForm orgId={orgId} workspaceId={workspaceId} />
    </ResourcePage>
  );
}

export default CreateTriggerPage;
