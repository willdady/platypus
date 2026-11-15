import type { Metadata } from "next";
import { AgentForm } from "@/components/agent-form";
import { ResourcePage } from "@/components/resource-page";
import { fetchToolSets, toolSetFormProps } from "@/lib/tool-sets-request";
import { backendPath } from "@/lib/server-read";

type Params = Promise<{ orgId: string; workspaceId: string; agentId: string }>;

export const metadata: Metadata = { title: "Edit Agent" };

async function AgentEditPage({ params }: { params: Params }) {
  const { orgId, workspaceId, agentId } = await params;

  // Fetch tool sets from the server. A failed read is reported to the form
  // rather than thrown, so the page still renders (issue #818).
  const toolSetsResult = await fetchToolSets(
    backendPath`/organizations/${orgId}/workspaces/${workspaceId}/tools`,
  );

  return (
    <ResourcePage title="Edit Agent" variant="narrow">
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
