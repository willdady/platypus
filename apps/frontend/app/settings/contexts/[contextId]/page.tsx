import { WorkspaceContextForm } from "@/components/workspace-context-form";
import { ResourcePage } from "@/components/resource-page";

const WorkspaceContextEditPage = async ({
  params,
}: {
  params: Promise<{ contextId: string }>;
}) => {
  const { contextId } = await params;

  return (
    <ResourcePage
      backFallbackHref="/settings/contexts"
      title="Edit Workspace Context"
    >
      <WorkspaceContextForm contextId={contextId} />
    </ResourcePage>
  );
};

export default WorkspaceContextEditPage;
