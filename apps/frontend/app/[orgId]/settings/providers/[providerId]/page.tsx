import { ProviderForm } from "@/components/provider-form";
import { ResourcePage } from "@/components/resource-page";

const EditOrgProviderPage = async ({
  params,
}: {
  params: Promise<{ orgId: string; providerId: string }>;
}) => {
  const { orgId, providerId } = await params;

  return (
    <ResourcePage
      backFallbackHref={`/${orgId}/settings/providers`}
      title="Edit Organization Provider"
    >
      <ProviderForm orgId={orgId} providerId={providerId} />
    </ResourcePage>
  );
};

export default EditOrgProviderPage;
