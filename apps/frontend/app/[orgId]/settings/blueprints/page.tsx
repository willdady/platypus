import { BlueprintsList } from "@/components/blueprints-list";

const OrgBlueprintsPage = async ({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) => {
  const { orgId } = await params;

  return (
    <div>
      <h1 className="text-2xl font-bold mb-4">Blueprints</h1>
      <p className="text-muted-foreground mb-6">
        A blueprint is a named set of shared resources. Apply it to a workspace
        to attach them all in one step. It is a snapshot — editing a blueprint
        never changes workspaces you have already provisioned from it.
      </p>
      <BlueprintsList orgId={orgId} />
    </div>
  );
};

export default OrgBlueprintsPage;
