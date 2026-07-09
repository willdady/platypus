import { BlueprintForm } from "@/components/blueprint-form";
import { BackButton } from "@/components/back-button";

const CreateBlueprintPage = async ({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) => {
  const { orgId } = await params;

  return (
    <div>
      <BackButton fallbackHref={`/${orgId}/settings/blueprints`} />
      <h1 className="text-2xl font-bold mb-4">Create Blueprint</h1>
      <BlueprintForm orgId={orgId} />
    </div>
  );
};

export default CreateBlueprintPage;
