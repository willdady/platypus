import { ProviderForm } from "@/components/provider-form";

const ProvidersPage = async ({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string }>;
}) => {
  const { orgId, workspaceId } = await params;

  return <ProviderForm orgId={orgId} workspaceId={workspaceId} />;
};

export default ProvidersPage;
