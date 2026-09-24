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
        Providers defined here are shared resources. They appear in a workspace
        only where an admin attaches them, and are edited only here.
      </p>
      <ProvidersList orgId={orgId} />
    </div>
  );
};

export default OrgProvidersPage;
