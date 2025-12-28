import { ProvidersList } from "@/components/providers-list";

const OrgProvidersPage = async ({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) => {
  const { orgId } = await params;

  return (
    <div>
      <h1 className="text-2xl font-bold mb-4">Organization Providers</h1>
      <p className="text-muted-foreground mb-6">
        Providers defined here are available to all workspaces in this
        organization.
      </p>
      <ProvidersList orgId={orgId} />
    </div>
  );
};

export default OrgProvidersPage;
