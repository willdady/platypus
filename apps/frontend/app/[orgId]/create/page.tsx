import { WorkspaceForm } from "@/components/workspace-form";
import { BackButton } from "@/components/back-button";
import { ProtectedRoute } from "@/components/protected-route";

const WorkspaceCreatePage = async ({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) => {
  const { orgId } = await params;

  return (
    <ProtectedRoute requireOrgAccess={true} requiredOrgRole="admin">
      <div className="flex justify-center w-full p-4">
        <div className="w-lg">
          <BackButton fallbackHref={`/${orgId}`} />
          <h1 className="text-2xl mb-4 font-bold">Create Workspace</h1>
          <WorkspaceForm orgId={orgId} />
        </div>
      </div>
    </ProtectedRoute>
  );
};

export default WorkspaceCreatePage;
