import { AgentForm } from "@/components/agent-form";
import { ResourcePage } from "@/components/resource-page";
import { fetchToolSets, toolSetFormProps } from "@/lib/tool-sets-request";
import { workspaceRoutes } from "@/lib/routes";
import { backendPath, readForLabel } from "@/lib/server-read";
import type { Metadata } from "next";

type Params = Promise<{ orgId: string; workspaceId: string; agentId: string }>;

export async function generateMetadata({
  params,
}: {
  params: Params;
}): Promise<Metadata> {
  const { orgId, workspaceId, agentId } = await params;
  const agent = await readForLabel<{ name: string }>(
    backendPath`/organizations/${orgId}/workspaces/${workspaceId}/agents/${agentId}`,
  );
  return { title: agent?.name || "Edit Agent" };
}

async function AgentEditPage({ params }: { params: Params }) {
  const { orgId, workspaceId, agentId } = await params;

  // Fetch tool sets from the server. A failed read is reported to the form
  // rather than thrown, so the page still renders (issue #818).
  const toolSetsResult = await fetchToolSets(
    backendPath`/organizations/${orgId}/workspaces/${workspaceId}/tools`,
  );

  return (
    <ResourcePage
      backFallbackHref={workspaceRoutes(orgId, workspaceId).root}
      title="Edit Agent"
      variant="narrow"
    >
      <AgentForm
        orgId={orgId}
        workspaceId={workspaceId}
        agentId={agentId}
        {...toolSetFormProps(toolSetsResult)}
      />
    </ResourcePage>
  );
}

export default AgentEditPage;
