import type { Metadata } from "next";
import { WebhookForm } from "@/components/webhook-form";
import { ResourcePage } from "@/components/resource-page";

export const metadata: Metadata = { title: "Add Webhook" };

async function WebhookCreatePage({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string }>;
}) {
  const { orgId, workspaceId } = await params;

  return (
    <ResourcePage title="Add Webhook">
      <WebhookForm orgId={orgId} workspaceId={workspaceId} />
    </ResourcePage>
  );
}

export default WebhookCreatePage;
