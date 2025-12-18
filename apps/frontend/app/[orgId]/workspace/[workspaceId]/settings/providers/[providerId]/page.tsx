import { ProviderForm } from "@/components/provider-form";
import { BackButton } from "@/components/back-button";

const ProviderEditPage = async ({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string; providerId: string }>;
}) => {
  const { orgId, workspaceId, providerId } = await params;

  return (
    <div>
      <BackButton
        fallbackHref={`/${orgId}/workspace/${workspaceId}/settings/providers`}
      />
      <h1 className="text-2xl mb-4 font-bold">Edit Provider</h1>
      <ProviderForm
        orgId={orgId}
        workspaceId={workspaceId}
        providerId={providerId}
      />
    </div>
  );
};

export default ProviderEditPage;
