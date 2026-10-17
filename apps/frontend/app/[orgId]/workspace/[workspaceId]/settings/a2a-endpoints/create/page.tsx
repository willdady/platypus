import type { Metadata } from "next";
import { A2aEndpointForm } from "@/components/a2a-endpoint-form";
import { ResourcePage } from "@/components/resource-page";
import { workspaceRoutes } from "@/lib/routes";

export const metadata: Metadata = { title: "Create A2A endpoint" };

async function A2aEndpointCreatePage({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string }>;
}) {
  const { orgId, workspaceId } = await params;

  return (
    <ResourcePage
      backFallbackHref={
        workspaceRoutes(orgId, workspaceId).settings.a2aEndpoints
      }
      title="Create A2A endpoint"
    >
      <A2aEndpointForm orgId={orgId} workspaceId={workspaceId} />
    </ResourcePage>
  );
}

export default A2aEndpointCreatePage;
