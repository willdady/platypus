import type { Metadata } from "next";
import { WebhookForm } from "@/components/webhook-form";
import { ResourcePage } from "@/components/resource-page";
import { workspaceRoutes } from "@/lib/routes";

export const metadata: Metadata = { title: "Create Webhook" };

async function WebhookCreatePage({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string }>;
}) {
  const { orgId, workspaceId } = await params;

  return (
    <ResourcePage
      backFallbackHref={workspaceRoutes(orgId, workspaceId).settings.webhooks}
      title="Create Webhook"
    >
      <WebhookForm orgId={orgId} workspaceId={workspaceId} />
    </ResourcePage>
  );
}

export default WebhookCreatePage;
