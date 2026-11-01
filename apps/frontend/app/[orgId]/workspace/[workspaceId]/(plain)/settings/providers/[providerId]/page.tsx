import type { Metadata } from "next";
import { ProviderForm } from "@/components/provider-form";
import { ResourcePage } from "@/components/resource-page";

export const metadata: Metadata = { title: "Edit Provider" };

async function ProviderEditPage({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string; providerId: string }>;
}) {
  const { orgId, workspaceId, providerId } = await params;

  return (
    <ResourcePage title="Edit Provider">
      <ProviderForm
        orgId={orgId}
        workspaceId={workspaceId}
        providerId={providerId}
      />
    </ResourcePage>
  );
}

export default ProviderEditPage;
