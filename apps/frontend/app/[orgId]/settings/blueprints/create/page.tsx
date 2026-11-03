import type { Metadata } from "next";
import { BlueprintForm } from "@/components/blueprint-form";
import { ResourcePage } from "@/components/resource-page";

export const metadata: Metadata = { title: "Create Blueprint" };

async function CreateBlueprintPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;

  return (
    <ResourcePage title="Create Blueprint">
      <BlueprintForm orgId={orgId} />
    </ResourcePage>
  );
}

export default CreateBlueprintPage;
