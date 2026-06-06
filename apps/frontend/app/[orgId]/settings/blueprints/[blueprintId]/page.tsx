import { BlueprintForm } from "@/components/blueprint-form";
import { BackButton } from "@/components/back-button";

const EditBlueprintPage = async ({
  params,
}: {
  params: Promise<{ orgId: string; blueprintId: string }>;
}) => {
  const { orgId, blueprintId } = await params;

  return (
    <div>
      <BackButton fallbackHref={`/${orgId}/settings/blueprints`} />
      <h1 className="text-2xl font-bold mb-4">Edit Blueprint</h1>
      <BlueprintForm orgId={orgId} blueprintId={blueprintId} />
    </div>
  );
};

export default EditBlueprintPage;
