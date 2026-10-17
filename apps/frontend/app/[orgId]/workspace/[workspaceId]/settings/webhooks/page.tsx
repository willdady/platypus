import type { Metadata } from "next";
import { WebhooksList } from "@/components/webhooks-list";

export const metadata: Metadata = { title: "Webhooks" };

async function WebhooksPage({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string }>;
}) {
  const { orgId, workspaceId } = await params;

  return (
    <div>
      <h1 className="text-2xl font-bold mb-4">Webhooks</h1>
      <WebhooksList orgId={orgId} workspaceId={workspaceId} />
    </div>
  );
}

export default WebhooksPage;
