import { ProviderForm } from "@/components/provider-form";
import { ResourcePage } from "@/components/resource-page";

const ProviderEditPage = async ({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string; providerId: string }>;
}) => {
  const { orgId, workspaceId, providerId } = await params;

  return (
    <ResourcePage
      backFallbackHref={`/${orgId}/workspace/${workspaceId}/settings/providers`}
      title="Edit Provider"
    >
      <ProviderForm
        orgId={orgId}
        workspaceId={workspaceId}
        providerId={providerId}
      />
    </ResourcePage>
  );
};

export default ProviderEditPage;
