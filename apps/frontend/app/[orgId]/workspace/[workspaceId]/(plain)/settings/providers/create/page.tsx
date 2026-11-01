import type { Metadata } from "next";
import { ProviderForm } from "@/components/provider-form";
import { ResourcePage } from "@/components/resource-page";

export const metadata: Metadata = { title: "Create Provider" };

async function ProviderCreatePage({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string }>;
}) {
  const { orgId, workspaceId } = await params;

  return (
    <ResourcePage title="Create Provider">
      <ProviderForm orgId={orgId} workspaceId={workspaceId} />
    </ResourcePage>
  );
}

export default ProviderCreatePage;
