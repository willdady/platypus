import { BlueprintForm } from "@/components/blueprint-form";
import { ResourcePage } from "@/components/resource-page";
import { orgRoutes } from "@/lib/routes";

const CreateBlueprintPage = async ({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) => {
  const { orgId } = await params;

  return (
    <ResourcePage
      backFallbackHref={orgRoutes(orgId).settings.blueprints}
      title="Create Blueprint"
    >
      <BlueprintForm orgId={orgId} />
    </ResourcePage>
  );
};

export default CreateBlueprintPage;
