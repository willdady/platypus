import { WorkspaceWizard } from "@/components/workspace-wizard";
import { ResourcePage } from "@/components/resource-page";
import { ProtectedRoute } from "@/components/protected-route";
import { orgRoutes } from "@/lib/routes";

const WorkspaceCreatePage = async ({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) => {
  const { orgId } = await params;

  return (
    <ProtectedRoute requireOrgAccess requireOrgAdmin>
      {/* No shell wraps this page, and the body doesn't scroll. */}
      <div className="h-dvh overflow-y-auto pb-4">
        <ResourcePage
          backFallbackHref={orgRoutes(orgId).root}
          title="Create Workspace"
          variant="wide"
        >
          <WorkspaceWizard orgId={orgId} />
        </ResourcePage>
      </div>
    </ProtectedRoute>
  );
};

export default WorkspaceCreatePage;
