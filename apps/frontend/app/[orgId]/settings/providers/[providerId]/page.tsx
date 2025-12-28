import { ProviderForm } from "@/components/provider-form";

const EditOrgProviderPage = async ({
  params,
}: {
  params: Promise<{ orgId: string; providerId: string }>;
}) => {
  const { orgId, providerId } = await params;

  return (
    <div>
      <h1 className="text-2xl font-bold mb-4">Edit Organization Provider</h1>
      <ProviderForm orgId={orgId} providerId={providerId} />
    </div>
  );
};

export default EditOrgProviderPage;
