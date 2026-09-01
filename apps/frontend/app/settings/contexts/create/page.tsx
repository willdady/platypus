import { WorkspaceContextForm } from "@/components/workspace-context-form";
import { ResourcePage } from "@/components/resource-page";

const WorkspaceContextCreatePage = () => {
  return (
    <ResourcePage
      backFallbackHref="/settings/contexts"
      title="Create Workspace Context"
    >
      <WorkspaceContextForm />
    </ResourcePage>
  );
};

export default WorkspaceContextCreatePage;
