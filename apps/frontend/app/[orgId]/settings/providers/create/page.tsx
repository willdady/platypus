import type { Metadata } from "next";
import { ProviderForm } from "@/components/provider-form";
import { ResourcePage } from "@/components/resource-page";

export const metadata: Metadata = { title: "Add Organization Provider" };

async function CreateOrgProviderPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;

  return (
    <ResourcePage title="Add Organization Provider">
      <ProviderForm orgId={orgId} />
    </ResourcePage>
  );
}

export default CreateOrgProviderPage;
