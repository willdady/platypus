import type { Metadata } from "next";
import { ProvidersList } from "@/components/providers-list";
import { PageHeader } from "@/components/page-header";

export const metadata: Metadata = { title: "Providers" };

async function ProvidersPage({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string }>;
}) {
  const { orgId, workspaceId } = await params;

  return (
    <div>
      <PageHeader title="Providers" />
      <ProvidersList orgId={orgId} workspaceId={workspaceId} />
    </div>
  );
}

export default ProvidersPage;
