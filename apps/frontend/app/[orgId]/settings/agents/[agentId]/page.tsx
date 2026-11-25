import type { Metadata } from "next";
import { AgentForm } from "@/components/agent-form";
import { ResourcePage } from "@/components/resource-page";
import { fetchToolSets, toolSetFormProps } from "@/lib/tool-sets-request";
import { backendPath } from "@/lib/server-read";

export const metadata: Metadata = { title: "Edit Shared Agent" };

async function OrgAgentEditPage({
  params,
}: {
  params: Promise<{ orgId: string; agentId: string }>;
}) {
  const { orgId, agentId } = await params;

  const toolSetsResult = await fetchToolSets(
    backendPath`/organizations/${orgId}/tools`,
  );

  return (
    <ResourcePage title="Edit Shared Agent">
      <AgentForm
        orgId={orgId}
        agentId={agentId}
        {...toolSetFormProps(toolSetsResult)}
        orgScoped
      />
    </ResourcePage>
  );
}

export default OrgAgentEditPage;
