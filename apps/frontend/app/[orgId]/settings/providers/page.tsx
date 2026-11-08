import type { Metadata } from "next";
import { ProvidersList } from "@/components/providers-list";
import { PageHeader } from "@/components/page-header";

export const metadata: Metadata = { title: "Organization Providers" };

async function OrgProvidersPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;

  return (
    <div>
      <PageHeader
        title="Organization Providers"
        description="Providers defined here are shared resources. They appear in a workspace only where an admin attaches them, and are edited only here."
      />
      <ProvidersList orgId={orgId} />
    </div>
  );
}

export default OrgProvidersPage;
