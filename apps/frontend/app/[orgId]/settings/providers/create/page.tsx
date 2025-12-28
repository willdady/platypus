import { ProviderForm } from "@/components/provider-form";

const CreateOrgProviderPage = async ({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) => {
  const { orgId } = await params;

  return (
    <div>
      <h1 className="text-2xl font-bold mb-4">Add Organisation Provider</h1>
      <ProviderForm orgId={orgId} />
    </div>
  );
};

export default CreateOrgProviderPage;
