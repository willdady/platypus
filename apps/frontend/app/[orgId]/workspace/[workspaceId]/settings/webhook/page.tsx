import { WebhookSettings } from "@/components/webhook-settings";

const WebhookPage = async ({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string }>;
}) => {
  const { orgId, workspaceId } = await params;

  return (
    <div>
      <h1 className="text-xl font-semibold mb-4">Webhook</h1>
      <WebhookSettings orgId={orgId} workspaceId={workspaceId} />
    </div>
  );
};

export default WebhookPage;
