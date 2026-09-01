import { WebhookForm } from "@/components/webhook-form";
import { ResourcePage } from "@/components/resource-page";

const WebhookEditPage = async ({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string; webhookId: string }>;
}) => {
  const { orgId, workspaceId, webhookId } = await params;

  return (
    <ResourcePage
      backFallbackHref={`/${orgId}/workspace/${workspaceId}/settings/webhooks`}
      title="Edit Webhook"
    >
      <WebhookForm
        orgId={orgId}
        workspaceId={workspaceId}
        webhookId={webhookId}
      />
    </ResourcePage>
  );
};

export default WebhookEditPage;
