import type { Metadata } from "next";
import { WebhooksList } from "@/components/webhooks-list";
import { PageHeader } from "@/components/page-header";

export const metadata: Metadata = { title: "Webhooks" };

async function WebhooksPage({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string }>;
}) {
  const { orgId, workspaceId } = await params;

  return (
    <div>
      <PageHeader title="Webhooks" />
      <WebhooksList orgId={orgId} workspaceId={workspaceId} />
    </div>
  );
}

export default WebhooksPage;
