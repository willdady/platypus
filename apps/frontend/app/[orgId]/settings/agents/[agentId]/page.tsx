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

  // Org-scoped tool sets: static sets + org MCPs (the only ones a Shared agent
  // may reference under the no-cascade rule). A failed read is reported to the
  // form rather than thrown, so the page still renders (issue #818).
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
