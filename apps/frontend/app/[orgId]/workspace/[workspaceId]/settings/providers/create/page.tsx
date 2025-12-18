import { ProviderForm } from "@/components/provider-form";
import { BackButton } from "@/components/back-button";

const ProviderCreatePage = async ({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string }>;
}) => {
  const { orgId, workspaceId } = await params;

  return (
    <div>
      <BackButton
        fallbackHref={`/${orgId}/workspace/${workspaceId}/settings/providers`}
      />
      <h1 className="text-2xl mb-4 font-bold">Create Provider</h1>
      <ProviderForm orgId={orgId} workspaceId={workspaceId} />
    </div>
  );
};

export default ProviderCreatePage;
