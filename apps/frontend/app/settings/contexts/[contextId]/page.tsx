import { WorkspaceContextForm } from "@/components/workspace-context-form";
import { ResourcePage } from "@/components/resource-page";
import { userRoutes } from "@/lib/routes";

const WorkspaceContextEditPage = async ({
  params,
}: {
  params: Promise<{ contextId: string }>;
}) => {
  const { contextId } = await params;

  return (
    <ResourcePage
      backFallbackHref={userRoutes.contexts}
      title="Edit Workspace Context"
    >
      <WorkspaceContextForm contextId={contextId} />
    </ResourcePage>
  );
};

export default WorkspaceContextEditPage;
