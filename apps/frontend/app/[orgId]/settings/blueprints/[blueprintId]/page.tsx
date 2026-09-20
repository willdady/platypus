import { BlueprintForm } from "@/components/blueprint-form";
import { ResourcePage } from "@/components/resource-page";
import { orgRoutes } from "@/lib/routes";

const EditBlueprintPage = async ({
  params,
}: {
  params: Promise<{ orgId: string; blueprintId: string }>;
}) => {
  const { orgId, blueprintId } = await params;

  return (
    <ResourcePage
      backFallbackHref={orgRoutes(orgId).settings.blueprints}
      title="Edit Blueprint"
    >
      <BlueprintForm orgId={orgId} blueprintId={blueprintId} />
    </ResourcePage>
  );
};

export default EditBlueprintPage;
