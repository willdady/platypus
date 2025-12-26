import { ProvidersList } from "@/components/providers-list";

const ProvidersPage = async ({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string }>;
}) => {
  const { orgId, workspaceId } = await params;

  return (
    <div>
      <h1 className="text-2xl font-bold mb-4">Providers</h1>
      <ProvidersList orgId={orgId} workspaceId={workspaceId} />
    </div>
  );
};

export default ProvidersPage;
