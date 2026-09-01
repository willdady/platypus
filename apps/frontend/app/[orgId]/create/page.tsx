import { WorkspaceForm } from "@/components/workspace-form";
import { ResourcePage } from "@/components/resource-page";
import { ProtectedRoute } from "@/components/protected-route";

const WorkspaceCreatePage = async ({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) => {
  const { orgId } = await params;

  return (
    <ProtectedRoute requireOrgAccess={true} requiredOrgRole="admin">
      <ResourcePage
        backFallbackHref={`/${orgId}`}
        title="Create Workspace"
        variant="wide"
      >
        <WorkspaceForm orgId={orgId} />
      </ResourcePage>
    </ProtectedRoute>
  );
};

export default WorkspaceCreatePage;
