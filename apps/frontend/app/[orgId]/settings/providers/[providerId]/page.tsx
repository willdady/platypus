import type { Metadata } from "next";
import { ProviderForm } from "@/components/provider-form";
import { ResourcePage } from "@/components/resource-page";
import { orgRoutes } from "@/lib/routes";

export const metadata: Metadata = { title: "Edit Organization Provider" };

async function EditOrgProviderPage({
  params,
}: {
  params: Promise<{ orgId: string; providerId: string }>;
}) {
  const { orgId, providerId } = await params;

  return (
    <ResourcePage
      backFallbackHref={orgRoutes(orgId).settings.providers}
      title="Edit Organization Provider"
    >
      <ProviderForm orgId={orgId} providerId={providerId} />
    </ResourcePage>
  );
}

export default EditOrgProviderPage;
