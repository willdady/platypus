import { ProviderForm } from "@/components/provider-form";
import { ResourcePage } from "@/components/resource-page";
import { workspaceRoutes } from "@/lib/routes";

const ProviderCreatePage = async ({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string }>;
}) => {
  const { orgId, workspaceId } = await params;

  return (
    <ResourcePage
      backFallbackHref={workspaceRoutes(orgId, workspaceId).settings.providers}
      title="Create Provider"
    >
      <ProviderForm orgId={orgId} workspaceId={workspaceId} />
    </ResourcePage>
  );
};

export default ProviderCreatePage;
