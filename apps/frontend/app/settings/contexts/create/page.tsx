import { WorkspaceContextForm } from "@/components/workspace-context-form";
import { BackButton } from "@/components/back-button";

const WorkspaceContextCreatePage = () => {
  return (
    <div>
      <BackButton fallbackHref="/settings/contexts" />
      <h1 className="text-2xl mb-4 font-bold">Create Workspace Context</h1>
      <WorkspaceContextForm />
    </div>
  );
};

export default WorkspaceContextCreatePage;
