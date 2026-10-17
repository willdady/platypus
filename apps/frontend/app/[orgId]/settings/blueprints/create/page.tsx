import type { Metadata } from "next";
import { BlueprintForm } from "@/components/blueprint-form";
import { ResourcePage } from "@/components/resource-page";
import { orgRoutes } from "@/lib/routes";

export const metadata: Metadata = { title: "Create Blueprint" };

async function CreateBlueprintPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;

  return (
    <ResourcePage
      backFallbackHref={orgRoutes(orgId).settings.blueprints}
      title="Create Blueprint"
    >
      <BlueprintForm orgId={orgId} />
    </ResourcePage>
  );
}

export default CreateBlueprintPage;
