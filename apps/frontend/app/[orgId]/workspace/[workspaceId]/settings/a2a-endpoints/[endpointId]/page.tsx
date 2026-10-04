import { A2aEndpointForm } from "@/components/a2a-endpoint-form";
import { ResourcePage } from "@/components/resource-page";
import { workspaceRoutes } from "@/lib/routes";

const A2aEndpointEditPage = async ({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string; endpointId: string }>;
}) => {
  const { orgId, workspaceId, endpointId } = await params;

  return (
    <ResourcePage
      backFallbackHref={
        workspaceRoutes(orgId, workspaceId).settings.a2aEndpoints
      }
      title="Edit A2A endpoint"
    >
      <A2aEndpointForm
        orgId={orgId}
        workspaceId={workspaceId}
        endpointId={endpointId}
      />
    </ResourcePage>
  );
};

export default A2aEndpointEditPage;
