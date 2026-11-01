import type { Metadata } from "next";
import { ProvidersList } from "@/components/providers-list";

export const metadata: Metadata = { title: "Providers" };

async function ProvidersPage({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string }>;
}) {
  const { orgId, workspaceId } = await params;

  return (
    <div>
      <h1 className="text-2xl font-bold mb-4">Providers</h1>
      <ProvidersList orgId={orgId} workspaceId={workspaceId} />
    </div>
  );
}

export default ProvidersPage;
