import { BlueprintForm } from "@/components/blueprint-form";
import { ResourcePage } from "@/components/resource-page";

const CreateBlueprintPage = async ({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) => {
  const { orgId } = await params;

  return (
    <ResourcePage
      backFallbackHref={`/${orgId}/settings/blueprints`}
      title="Create Blueprint"
    >
      <BlueprintForm orgId={orgId} />
    </ResourcePage>
  );
};

export default CreateBlueprintPage;
