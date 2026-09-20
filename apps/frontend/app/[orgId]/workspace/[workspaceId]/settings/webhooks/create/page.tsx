import { WebhookForm } from "@/components/webhook-form";
import { ResourcePage } from "@/components/resource-page";
import { workspaceRoutes } from "@/lib/routes";

const WebhookCreatePage = async ({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string }>;
}) => {
  const { orgId, workspaceId } = await params;

  return (
    <ResourcePage
      backFallbackHref={workspaceRoutes(orgId, workspaceId).settings.webhooks}
      title="Create Webhook"
    >
      <WebhookForm orgId={orgId} workspaceId={workspaceId} />
    </ResourcePage>
  );
};

export default WebhookCreatePage;
