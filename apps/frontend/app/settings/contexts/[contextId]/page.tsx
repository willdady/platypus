import { WorkspaceContextForm } from "@/components/workspace-context-form";
import { BackButton } from "@/components/back-button";

const WorkspaceContextEditPage = async ({
  params,
}: {
  params: Promise<{ contextId: string }>;
}) => {
  const { contextId } = await params;

  return (
    <div>
      <BackButton fallbackHref="/settings/contexts" />
      <h1 className="text-2xl mb-4 font-bold">Edit Workspace Context</h1>
      <WorkspaceContextForm contextId={contextId} />
    </div>
  );
};

export default WorkspaceContextEditPage;
