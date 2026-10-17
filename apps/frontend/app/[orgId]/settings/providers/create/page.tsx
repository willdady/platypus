import type { Metadata } from "next";
import { ProviderForm } from "@/components/provider-form";
import { ResourcePage } from "@/components/resource-page";
import { orgRoutes } from "@/lib/routes";

export const metadata: Metadata = { title: "Add Organization Provider" };

async function CreateOrgProviderPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;

  return (
    <ResourcePage
      backFallbackHref={orgRoutes(orgId).settings.providers}
      title="Add Organization Provider"
    >
      <ProviderForm orgId={orgId} />
    </ResourcePage>
  );
}

export default CreateOrgProviderPage;
