import type { Metadata } from "next";
import { BlueprintForm } from "@/components/blueprint-form";
import { ResourcePage } from "@/components/resource-page";

export const metadata: Metadata = { title: "Edit Blueprint" };

async function EditBlueprintPage({
  params,
}: {
  params: Promise<{ orgId: string; blueprintId: string }>;
}) {
  const { orgId, blueprintId } = await params;

  return (
    <ResourcePage title="Edit Blueprint">
      <BlueprintForm orgId={orgId} blueprintId={blueprintId} />
    </ResourcePage>
  );
}

export default EditBlueprintPage;
