import type { Metadata } from "next";
import { BlueprintsList } from "@/components/blueprints-list";
import { PageHeader } from "@/components/page-header";

export const metadata: Metadata = { title: "Blueprints" };

async function OrgBlueprintsPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;

  return (
    <div>
      <PageHeader
        title="Blueprints"
        description="A blueprint is a named set of shared resources. Apply it to a workspace to attach them all in one step. It is a snapshot — editing a blueprint never changes workspaces you have already provisioned from it."
      />
      <BlueprintsList orgId={orgId} />
    </div>
  );
}

export default OrgBlueprintsPage;
