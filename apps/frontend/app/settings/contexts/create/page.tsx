import { WorkspaceContextForm } from "@/components/workspace-context-form";
import { ResourcePage } from "@/components/resource-page";
import { userRoutes } from "@/lib/routes";

const WorkspaceContextCreatePage = () => {
  return (
    <ResourcePage
      backFallbackHref={userRoutes.contexts}
      title="Create Workspace Context"
    >
      <WorkspaceContextForm />
    </ResourcePage>
  );
};

export default WorkspaceContextCreatePage;
