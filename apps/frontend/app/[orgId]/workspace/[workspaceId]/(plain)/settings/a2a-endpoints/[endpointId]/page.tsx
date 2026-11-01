import type { Metadata } from "next";
import { A2aEndpointForm } from "@/components/a2a-endpoint-form";
import { ResourcePage } from "@/components/resource-page";

export const metadata: Metadata = { title: "Edit A2A endpoint" };

async function A2aEndpointEditPage({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string; endpointId: string }>;
}) {
  const { orgId, workspaceId, endpointId } = await params;

  return (
    <ResourcePage title="Edit A2A endpoint">
      <A2aEndpointForm
        orgId={orgId}
        workspaceId={workspaceId}
        endpointId={endpointId}
      />
    </ResourcePage>
  );
}

export default A2aEndpointEditPage;
